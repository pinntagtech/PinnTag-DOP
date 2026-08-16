import sys
import asyncio

# Fix Windows Python 3.13+ event loop for Playwright
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(
        asyncio.WindowsProactorEventLoopPolicy()
    )

from fastapi import FastAPI, BackgroundTasks, Header, HTTPException
from pydantic import BaseModel
from typing import Optional
import httpx
import asyncio
import json
import logging
import os
import random
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv
from datetime import datetime, timezone

load_dotenv()

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
NUMERIC_LEVEL = getattr(logging, LOG_LEVEL, logging.INFO)

logging.basicConfig(
    level=NUMERIC_LEVEL,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    datefmt='%H:%M:%S',
    stream=sys.stdout,
)

# Set same level on scraper logger
logging.getLogger('pinntag-scraper').setLevel(NUMERIC_LEVEL)

logger = logging.getLogger('pinntag-bot')


async def self_update_if_newer() -> None:
    """Pull manifest from API, replace local files if remote is newer.

    Re-execs the process once with os.execv when a new version was
    written, so the freshly-downloaded code starts running. A loop-guard
    env flag (BOT_UPDATE_BOOTED_AFTER) ensures we don't ping-pong: if
    we've already re-exec'd into the booted version, we skip.

    Never raises. Any failure is logged and startup continues on the
    currently-installed code.
    """
    if SELF_UPDATE_DISABLED:
        logger.info('[UPDATE] BOT_SELF_UPDATE=false — skipping')
        return

    # Loop guard: after a successful re-exec we set this env var to the
    # version we just booted. If it matches the version we'd download
    # again, we MUST NOT exec a second time.
    booted_after = os.environ.get('BOT_UPDATE_BOOTED_AFTER', '')

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                f'{DOP_API_URL}/api/v1/seeding/bot/source/manifest',
                headers={'x-bot-secret': DOP_WEBHOOK_SECRET},
            )
            if r.status_code != 200:
                logger.warning(
                    f'[UPDATE] manifest fetch returned {r.status_code} '
                    f'— skipped'
                )
                return
            manifest = r.json()
    except Exception as e:
        logger.warning(f'[UPDATE] skipped (manifest fetch failed): {e}')
        return

    remote_version = str(manifest.get('version', '') or '').strip()
    if not remote_version:
        logger.warning('[UPDATE] skipped (empty remote version)')
        return

    if remote_version == BOT_VERSION:
        logger.info(f'[UPDATE] already up to date (v{BOT_VERSION})')
        return

    if booted_after == remote_version:
        # We already re-exec'd into this version on a previous boot of
        # this PID lineage but the on-disk BOT_VERSION read stale.
        # Without this guard a clock-skew / read race could trigger an
        # infinite exec loop.
        logger.warning(
            f'[UPDATE] loop-guard tripped — already booted v{remote_version}'
        )
        return

    logger.info(
        f'[UPDATE] new version available: {BOT_VERSION} -> {remote_version}'
    )

    # ── Download every whitelisted file before overwriting anything ──
    # If any file fails, abort with NO changes on disk (atomic-ish).
    staged: dict[str, bytes] = {}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            for name in UPDATE_FILES:
                if name in UPDATE_PROTECTED:
                    continue
                r = await client.get(
                    f'{DOP_API_URL}/api/v1/seeding/bot/source/file/{name}',
                    headers={'x-bot-secret': DOP_WEBHOOK_SECRET},
                )
                if r.status_code != 200:
                    raise RuntimeError(
                        f'{name} fetch returned {r.status_code}'
                    )
                staged[name] = r.content
    except Exception as e:
        logger.warning(f'[UPDATE] skipped (file fetch failed): {e}')
        return

    # ── Commit to disk ─────────────────────────────────────────
    try:
        for name, content in staged.items():
            target = BOT_DIR / name
            # Triple-check we're not clobbering operator-local files.
            if target.name in UPDATE_PROTECTED:
                continue
            tmp = target.with_suffix(target.suffix + '.new')
            tmp.write_bytes(content)
            os.replace(tmp, target)
    except Exception as e:
        logger.error(f'[UPDATE] write failed mid-flight: {e}')
        return

    logger.info(
        '\n'
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
        f'  Updated to v{remote_version} — re-executing\n'
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    )

    # Set loop-guard BEFORE exec so the child sees it.
    os.environ['BOT_UPDATE_BOOTED_AFTER'] = remote_version
    # Re-exec preserves the parent's env + argv. uvicorn picks main:app
    # back up from this same file on the new code.
    try:
        os.execv(sys.executable, [sys.executable, *sys.argv])
    except Exception as e:
        # Exec failed — log and continue on the (already-updated on
        # disk) code. The next restart will pick it up cleanly.
        logger.error(f'[UPDATE] os.execv failed: {e}')


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info('PinnTag Bot Service starting up')
    logger.info(f'Bot version: {BOT_VERSION}')
    logger.info(f'DOP API URL: {DOP_API_URL}')
    logger.info(f'Cookies present: {Path(GOOGLE_COOKIES_PATH).exists()}')
    logger.info(f'Max reviews: {MAX_REVIEWS}')
    logger.info(f'Max gallery per folder: {MAX_GALLERY}')
    logger.info(f'Headless mode: {HEADLESS}')
    logger.info(
        f"Browser: channel={BOT_BROWSER_CHANNEL or 'none'} "
        f"CHROME_PATH={os.getenv('CHROME_PATH', '').strip() or 'unset'} "
        f"system_chrome={_detect_system_chrome() or 'none'}"
    )
    logger.info(f'Log level: {LOG_LEVEL}')

    # Self-update runs BEFORE we kick off the poll loops. If it finds a
    # newer version it overwrites the .py files and os.execv's into the
    # new process — nothing below this line gets reached on that path.
    await self_update_if_newer()

    logger.info(
        f'Resolve pool: workers={RESOLVE_WORKERS} '
        f'jitter_ms={RESOLVE_JITTER_MS}'
    )
    logger.info(
        f'Discovery pool: workers={DISCOVERY_WORKERS} '
        f'jitter_ms={DISCOVERY_JITTER_MS}'
    )

    # Start background polling loops:
    #  - polling_loop:      serial path for gallery_menu / reviews /
    #                       image_sync / cover_sync (claims via /bot/poll,
    #                       resolve + discovery excluded server-side so
    #                       the pools below own them).
    #  - resolve_pool_loop: parallel worker pool for resolve_business
    #                       jobs, shared Chromium + per-job context.
    #  - discovery_pool_loop: same shape as resolve, for DISCOVERY_SEARCH
    #                       jobs. Independent Chromium so a discovery
    #                       burst can't starve resolve or vice versa.
    poll_task = asyncio.create_task(polling_loop())
    resolve_pool_task = asyncio.create_task(resolve_pool_loop())
    discovery_pool_task = asyncio.create_task(discovery_pool_loop())

    yield

    logger.info('PinnTag Bot Service shutting down')
    for t in (poll_task, resolve_pool_task, discovery_pool_task):
        t.cancel()
    for t in (poll_task, resolve_pool_task, discovery_pool_task):
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass


app = FastAPI(title="PinnTag Bot Service", version="1.0.0", lifespan=lifespan)

# Resolve API URL based on active environment
DOP_ENV = os.getenv("DOP_ENV", "staging").lower().replace("-", "_")
DOP_API_URL = os.getenv(
    f"DOP_API_URL_{DOP_ENV.upper()}",
    os.getenv("DOP_API_URL", "http://localhost:3000"),
)
DOP_WEBHOOK_SECRET = os.getenv("DOP_API_WEBHOOK_SECRET", "pinntag_bot_2026")

print(f"[BOT] Environment: {DOP_ENV}")
print(f"[BOT] API URL: {DOP_API_URL}")
GOOGLE_COOKIES_PATH = os.getenv("GOOGLE_COOKIES_PATH", "./google_cookies.json")
MAX_REVIEWS = int(os.getenv("MAX_REVIEWS", "100"))
MAX_GALLERY = int(os.getenv("MAX_GALLERY_PER_FOLDER", "50"))
HEADLESS = os.getenv("HEADLESS", "true").lower() == "true"
CHROME_USER_DATA_DIR = os.getenv("CHROME_USER_DATA_DIR", "")
CHROME_PROFILE = os.getenv("CHROME_PROFILE", "Default")


# Browser engine selection. Priority:
#   1) BOT_BROWSER_CHANNEL  (e.g. 'chrome') — explicit channel hatch
#   2) CHROME_PATH          — explicit executable override
#   3) bundled Chromium     — IF actually installed (Mac, older Ubuntu);
#                             gallery code relies on its clean place-card
#                             landing, so it stays the default where present
#   4) system Google Chrome — auto-detected; required on Ubuntu 26.04 where
#                             bundled Chromium cannot be installed
#   5) loud failure         — nothing usable found
BOT_BROWSER_CHANNEL = os.getenv("BOT_BROWSER_CHANNEL", "").strip()

_SYS_CHROME_CANDIDATES = (
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)


def _detect_system_chrome() -> Optional[str]:
    """Return a system Google Chrome path if one exists, else None.
    CHROME_PATH env (if set) always wins."""
    env = os.getenv("CHROME_PATH", "").strip()
    if env:
        return env
    for path in _SYS_CHROME_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


_LAUNCH_LOGGED = False


# ── Off-screen windowed launch ─────────────────────────────────────
#
# Push the visible browser window off the monitor via
# --window-position=-2400,-2400 so the operator's screen stays clean
# during long scrapes, WITHOUT switching to headless (Google's headful
# fingerprint is much less flagged than headless — keep the real rendered
# behavior, just move it off-screen).
#
# Behavior per environment (feature-flag: BOT_OFFSCREEN, default true):
#   - macOS                              → apply offscreen args
#   - Linux + $DISPLAY / $WAYLAND_DISPLAY → apply offscreen args
#     (unreliable on Wayland but harmless; best-effort)
#   - Linux + no display, Xvfb installed → start Xvfb :99, apply args
#   - Linux + no display, no Xvfb        → skip, log warning
#     (do NOT silently switch to headless — detection risk out of scope)
#
# Detection runs once at import; the Xvfb subprocess (if started) is
# kept alive for the process lifetime and killed at exit.
def _detect_offscreen_mode():
    import subprocess
    import shutil
    import atexit
    import time as _time

    if os.getenv("BOT_OFFSCREEN", "true").lower() in ("false", "0", "no"):
        return [], "disabled_by_env", None

    is_mac = sys.platform == "darwin"
    has_display = is_mac or bool(
        os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    )
    offscreen_args = ["--window-position=-2400,-2400", "--window-size=1280,800"]

    if has_display:
        mode = "mac" if is_mac else (
            "linux_wayland" if os.environ.get("WAYLAND_DISPLAY") else "linux_x11"
        )
        return offscreen_args, mode, None

    # No display — try Xvfb.
    xvfb_path = shutil.which("Xvfb")
    if not xvfb_path:
        return [], "no_display_no_xvfb", None

    try:
        proc = subprocess.Popen(
            [xvfb_path, ":99", "-screen", "0", "1280x800x24"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        os.environ["DISPLAY"] = ":99"
        # Xvfb needs a moment to bind. Small blocking sleep is fine —
        # this runs once at import, not per launch.
        _time.sleep(0.5)
        atexit.register(lambda: (proc.terminate(), proc.wait(timeout=2)))
        return offscreen_args, "xvfb", proc
    except Exception as e:
        logging.getLogger(__name__).warning(
            f"[BROWSER] Xvfb start failed: {e}; falling back to no-offscreen"
        )
        return [], "xvfb_failed", None


_OFFSCREEN_ARGS, _OFFSCREEN_MODE, _XVFB_PROC = _detect_offscreen_mode()


async def launch_browser(p, *, headless: bool, args: list):
    """Single launch path for every scrape. Resolves the browser by the
    priority documented above so the SAME code runs on Mac (bundled) and
    Ubuntu 26.04 (system Chrome) with no per-machine config. Also merges
    off-screen positioning args (see _detect_offscreen_mode) unless the
    caller already supplied a conflicting --window-position/--window-size,
    in which case the caller wins."""
    global _LAUNCH_LOGGED
    merged_args = list(args)
    caller_has_position = any(a.startswith("--window-position") for a in args)
    caller_has_size = any(a.startswith("--window-size") for a in args)
    for oa in _OFFSCREEN_ARGS:
        if oa.startswith("--window-position") and caller_has_position:
            continue
        if oa.startswith("--window-size") and caller_has_size:
            continue
        merged_args.append(oa)
    kwargs = dict(headless=headless, args=merged_args)
    chosen = None

    if BOT_BROWSER_CHANNEL:
        # 1) explicit channel hatch
        kwargs["channel"] = BOT_BROWSER_CHANNEL
        chosen = f"channel={BOT_BROWSER_CHANNEL}"
    else:
        env_path = os.getenv("CHROME_PATH", "").strip()
        if env_path:
            # 2) explicit executable override
            kwargs["executable_path"] = env_path
            chosen = f"system Chrome (CHROME_PATH={env_path})"
        else:
            # 3) bundled Chromium only if it's actually on disk
            bundled_ok = False
            try:
                bundled = p.chromium.executable_path
                bundled_ok = bool(bundled) and os.path.exists(bundled)
            except Exception:
                bundled_ok = False
            if bundled_ok:
                chosen = "bundled Chromium"
            else:
                # 4) system Chrome fallback (Ubuntu 26.04)
                sys_chrome = _detect_system_chrome()
                if sys_chrome:
                    kwargs["executable_path"] = sys_chrome
                    chosen = f"system Chrome ({sys_chrome})"
                else:
                    # 5) loud fail — clearer than Playwright's stack trace
                    raise RuntimeError(
                        "No usable browser found: bundled Chromium is not "
                        "installed and no system Google Chrome was detected. "
                        "Install Google Chrome (Ubuntu 26.04) or run "
                        "`playwright install chromium`."
                    )

    if not _LAUNCH_LOGGED:
        logger.info(f"[BROWSER] using {chosen} (offscreen: {_OFFSCREEN_MODE})")
        _LAUNCH_LOGGED = True

    browser = await p.chromium.launch(**kwargs)

    # macOS-only follow-up. --window-position moves the window off the
    # visible screen, but macOS still steals focus and re-shows new /
    # navigating windows regardless. Wrap browser.new_context so every
    # context's first page also gets a CDP minimize — belt-and-suspenders
    # that keeps the window hidden even when focus gets stolen. Kept
    # macOS-only per spec; Linux (x11 / wayland / xvfb / no-display)
    # behavior is unchanged.
    if sys.platform == "darwin" and _OFFSCREEN_MODE == "mac":
        _install_mac_minimize_hook(browser)

    return browser


def _install_mac_minimize_hook(browser):
    """Monkey-patch browser.new_context on macOS so each new context's
    initial page gets a CDP `Browser.setWindowBounds windowState:minimized`
    applied right after creation. Silent no-op on any failure (Playwright
    proxy that disallows attribute assignment, CDP session failure,
    etc.) — the --window-position offset is still in place."""
    try:
        original_new_context = browser.new_context
    except Exception as e:
        logger.warning(f"[BROWSER] macOS minimize hook: cannot read new_context ({e})")
        return

    async def _minimize_page(context, page):
        try:
            cdp = await context.new_cdp_session(page)
            info = await cdp.send("Browser.getWindowForTarget")
            await cdp.send(
                "Browser.setWindowBounds",
                {"windowId": info["windowId"], "bounds": {"windowState": "minimized"}},
            )
            await cdp.detach()
        except Exception as e:
            logger.warning(f"[BROWSER] macOS window minimize failed: {e}")

    async def wrapped_new_context(*args, **kwargs):
        context = await original_new_context(*args, **kwargs)
        # context.on('page') fires for every new page in the context,
        # including popups. Minimizing an already-minimized window is a
        # no-op, so a re-fire on new pages is harmless.
        context.on(
            "page",
            lambda page: asyncio.create_task(_minimize_page(context, page)),
        )
        return context

    try:
        browser.new_context = wrapped_new_context
    except Exception as e:
        logger.warning(f"[BROWSER] macOS minimize hook: cannot patch new_context ({e})")

SKIP_FOLDERS = {
    'all',
    'latest',
}


POLL_INTERVAL = 5  # seconds between polls


# ─── Resolve query sanitizer + name-match helpers ─────────────
# Two of the three fixes in recover-resolve-failures.md live here so the
# bot is self-sufficient regardless of which enqueue path the job came
# from. The API applies the same rules on the way in
# (query-sanitizer.ts / name-match.ts), but a pending job predating that
# deploy — or a job enqueued via a path that skipped the API-side
# sanitizer — must not poison Google's search or reject a good drill-in
# match downstream. Belt-and-suspenders, and the bot is the last line
# before Google.
import re as _re


_PHONE_RE = _re.compile(r'^\+?[\d\s().-]{7,}$')
_URL_RE = _re.compile(r'^\s*(https?://|www\.)', _re.I)
_DOMAIN_TAIL_RE = _re.compile(r'\.[a-z]{2,4}\b', _re.I)
_HOURS_TEXT_RE = _re.compile(
    r'\b(?:open\s+24\s+hours?|closed|hours?[:\s])', _re.I,
)
_POSTAL_ONLY_RE = _re.compile(
    r'^[^,]+,\s*[A-Za-z]{2}\s+\d{5}(?:-\d{4})?\s*$',
)
_STREET_RE = _re.compile(
    r'\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|'
    r'way|ct|court|pl|place|hwy|highway|pkwy|parkway|ter|terrace|cir|'
    r'circle|sq|square|broadway|turnpike|tpke|trail|trl|loop|alley|aly|'
    r'row|walk|plaza|plz|crossing|xing)\b',
    _re.I,
)
_HAS_DIGIT_RE = _re.compile(r'\d')

# Continental US bounding box — the API side uses the same constants
# (gate-predicates.ts). Kept in sync here so the coord-contradiction
# check produces the same answer regardless of which side runs it.
_US_LAT_MIN, _US_LAT_MAX = 24.396308, 49.384358
_US_LNG_MIN, _US_LNG_MAX = -124.848974, -66.885444

_US_STATES = {
    'alabama','alaska','arizona','arkansas','california','colorado',
    'connecticut','delaware','florida','georgia','hawaii','idaho',
    'illinois','indiana','iowa','kansas','kentucky','louisiana','maine',
    'maryland','massachusetts','michigan','minnesota','mississippi',
    'missouri','montana','nebraska','nevada','new hampshire','new jersey',
    'new mexico','new york','north carolina','north dakota','ohio',
    'oklahoma','oregon','pennsylvania','rhode island','south carolina',
    'south dakota','tennessee','texas','utah','vermont','virginia',
    'washington','west virginia','wisconsin','wyoming',
    'district of columbia','dc','puerto rico','pr',
    'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il',
    'in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt',
    'ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri',
    'sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy',
}


def _address_line1_is_junk(raw) -> bool:
    """FIX 3: reject an addressLine1 that would poison the Google Maps
    search. Real staging examples the plan doc calls out:
      "+1 501-804-9227"                         (phone-only)
      "corpwellness.org"                        (bare domain)
      "Miami, FL 33131"                         (postal fragment)
      "Yoga"                                    (no digit, no street)
    """
    s = (raw or '').strip()
    if not s:
        return False  # empty is handled by the caller's fallback chain
    if _PHONE_RE.match(s):
        return True
    if _URL_RE.match(s):
        return True
    if _HOURS_TEXT_RE.search(s):
        return True
    has_digit = bool(_HAS_DIGIT_RE.search(s))
    if _DOMAIN_TAIL_RE.search(s) and not has_digit:
        return True
    if _POSTAL_ONLY_RE.match(s) and not _STREET_RE.search(s):
        return True
    if not has_digit and not _STREET_RE.search(s):
        return True
    return False


def _city_is_junk(raw) -> bool:
    """City-side variant. Only rejects the exact phone/URL/bare-domain
    shapes — a legitimate city name never carries a digit sequence long
    enough to trip the phone regex, so this is safe."""
    s = (raw or '').strip()
    if not s:
        return False
    if _PHONE_RE.match(s):
        return True
    if _URL_RE.match(s):
        return True
    if _DOMAIN_TAIL_RE.search(s) and not _HAS_DIGIT_RE.search(s):
        return True
    return False


def _coords_in_us(lat, lng) -> bool:
    try:
        return (
            _US_LAT_MIN <= float(lat) <= _US_LAT_MAX
            and _US_LNG_MIN <= float(lng) <= _US_LNG_MAX
        )
    except Exception:
        return False


# Full-name → 2-letter code lookup for state normalization. `_US_STATES`
# above holds both forms as a membership set; this dict is the one-way
# canonical map used by the state cross-validation guard so "GA",
# "Georgia" and "georgia" all compare equal.
_US_STATE_CODE_BY_NAME = {
    'alabama':'al','alaska':'ak','arizona':'az','arkansas':'ar',
    'california':'ca','colorado':'co','connecticut':'ct','delaware':'de',
    'florida':'fl','georgia':'ga','hawaii':'hi','idaho':'id',
    'illinois':'il','indiana':'in','iowa':'ia','kansas':'ks',
    'kentucky':'ky','louisiana':'la','maine':'me','maryland':'md',
    'massachusetts':'ma','michigan':'mi','minnesota':'mn',
    'mississippi':'ms','missouri':'mo','montana':'mt','nebraska':'ne',
    'nevada':'nv','new hampshire':'nh','new jersey':'nj',
    'new mexico':'nm','new york':'ny','north carolina':'nc',
    'north dakota':'nd','ohio':'oh','oklahoma':'ok','oregon':'or',
    'pennsylvania':'pa','rhode island':'ri','south carolina':'sc',
    'south dakota':'sd','tennessee':'tn','texas':'tx','utah':'ut',
    'vermont':'vt','virginia':'va','washington':'wa','west virginia':'wv',
    'wisconsin':'wi','wyoming':'wy',
    'district of columbia':'dc','puerto rico':'pr',
}
_US_STATE_CODES = set(_US_STATE_CODE_BY_NAME.values())

# Google formatted addresses look like
#   "927 Fulton St, Brooklyn, NY 11238, United States"
#   "123 Main St, Miami, FL 33131"
#   "Suite 200, 1 Elm Rd, New York, New York 10001, USA"
# Anchor on ", <state token(s)> <5-digit ZIP>" so we don't misread a
# 5-digit street number as the ZIP.
_STATE_FROM_ADDR_RE = _re.compile(
    r',\s*([A-Za-z][A-Za-z .]{1,25}?)\s+\d{5}(?:-\d{4})?'
    r'\s*(?:,\s*(?:USA|United States|US))?\s*$'
)


def _normalize_state(raw) -> str:
    """Return a 2-letter lowercase state code, or '' if we can't tell."""
    s = (raw or '').strip().lower()
    if not s:
        return ''
    if len(s) == 2 and s in _US_STATE_CODES:
        return s
    return _US_STATE_CODE_BY_NAME.get(s, '')


def _extract_state_from_formatted(addr) -> str:
    """Pull the state out of a Google-formatted address string, or ''
    if the pattern doesn't match. The 5-digit ZIP anchor keeps this
    from mistaking a numeric street prefix for a ZIP."""
    if not addr:
        return ''
    m = _STATE_FROM_ADDR_RE.search(addr)
    if not m:
        return ''
    return _normalize_state(m.group(1))


def _sanitize_query_fields(
    address_line1, address1_fallback, city, state, lat, lng,
) -> dict:
    """Return the (address, city, state) the bot should actually search
    with, along with reasons for each drop so we can log them.

    Priority chain for the address:
      1) addressLine1 if present and non-junk
      2) address1 (legacy field) if present and non-junk
      3) empty — the query becomes name + city + state, which is still
                 viable when city/state carry real signal

    City/state get dropped together when domestic coords contradict a
    non-US state — the "US business carrying Spanish city" pattern the
    plan doc calls out. `state` alone can't be dropped without `city`
    (they only make sense as a pair for Google's search).
    """
    a1 = (address_line1 or '').strip()
    a1_fb = (address1_fallback or '').strip()
    dropped_reason = None
    if a1 and _address_line1_is_junk(a1):
        dropped_reason = 'a1_junk'
        a1 = ''
    if not a1 and a1_fb and not _address_line1_is_junk(a1_fb):
        a1 = a1_fb
        dropped_reason = dropped_reason or 'used_address1_fallback'

    c = (city or '').strip()
    s = (state or '').strip()
    dropped_cs = False
    if lat is not None and lng is not None and _coords_in_us(lat, lng):
        if s and s.lower() not in _US_STATES:
            dropped_cs = True
    if c and _city_is_junk(c):
        c = ''
    if dropped_cs:
        c = ''
        s = ''
    return {
        'addressLine1': a1,
        'city': c,
        'state': s,
        'droppedReason': dropped_reason,
        'droppedCityState': dropped_cs,
    }


# ── Fix 2: loosened name-match, applied to drill-in / two-hop scoring ──
# Mirrors apps/api/src/modules/seeding/resolve/name-match.ts so the
# bot's own drill-in decision uses the same acceptance criteria the API
# will use post-webhook. If we click into a candidate the API would
# later reject as name_mismatch, we've wasted a nav and lost a row.

_PUNCT_RE = _re.compile(r'[^\w\s]+', _re.U)

_STOPWORDS = {
    'the', 'a', 'an', 'of', 'and', 'co', 'inc', 'llc', 'ltd',
    'limited', 'corp', 'corporation', 'company',
}

_COMMON_SUFFIXES = {
    'restaurant', 'cafe', 'coffee', 'bar', 'grill', 'salon', 'spa',
    'studio', 'gallery', 'shop', 'store', 'boutique', 'inc', 'llc',
    'co', 'company', 'winery', 'brewery', 'distillery', 'kitchen',
    'lounge', 'club', 'center', 'centre', 'hotel', 'inn', 'motel',
    'pub', 'tavern', 'bakery', 'diner', 'bistro', 'eatery', 'market',
    'shoppe', 'academy', 'llp',
}

_GENERIC_TOKENS = {
    'the', 'a', 'an', 'of', 'and',
    'cafe', 'bar', 'grill', 'salon', 'spa', 'studio', 'gallery',
    'shop', 'store', 'restaurant', 'kitchen', 'lounge', 'club',
    'hair', 'beauty', 'nail', 'nails', 'hotel', 'inn', 'boutique',
    'coffee', 'tea', 'food', 'bistro', 'academy',
    'atlanta', 'nyc', 'ny', 'la', 'sf', 'boston', 'miami', 'brooklyn',
    'manhattan',
}


def _strip_diacritics(s: str) -> str:
    import unicodedata
    return ''.join(
        c for c in unicodedata.normalize('NFD', s)
        if unicodedata.category(c) != 'Mn'
    )


def _normalize_name(value) -> str:
    if not value:
        return ''
    spaced = _strip_diacritics(str(value).lower())
    spaced = spaced.replace('&', ' and ')
    spaced = _PUNCT_RE.sub(' ', spaced)
    spaced = _re.sub(r'\s+', ' ', spaced).strip()
    # Glue single-letter runs ("m a d beauty" → "mad beauty") so
    # "M.A.D. Beauty" collapses to the same token set as Google's
    # "Mad Beauty Bar".
    return _re.sub(
        r'\b[a-z](?:\s[a-z])+\b',
        lambda m: m.group(0).replace(' ', ''),
        spaced,
    )


def _stem_plural(t: str) -> str:
    if len(t) > 3 and t.endswith('ies'):
        return t[:-3] + 'y'
    if (len(t) > 3 and t.endswith('s')
            and not t.endswith('ss') and not t.endswith('us')):
        return t[:-1]
    return t


def _tokenize(value: str) -> list:
    n = _normalize_name(value)
    if not n:
        return []
    return [
        _stem_plural(t)
        for t in n.split(' ')
        if t and t not in _STOPWORDS
    ]


def _strip_trailing_city(norm: str, city) -> str:
    c = _normalize_name(city or '')
    if not c:
        return norm
    if norm.endswith(' ' + c):
        return norm[: -(len(c) + 1)].strip()
    if norm == c:
        return ''
    return norm


def _strip_trailing_suffixes(toks: list) -> list:
    out = list(toks)
    while len(out) > 1 and out[-1] in _COMMON_SUFFIXES:
        out.pop()
    return out


def _names_loose_match(stored, resolved, city=None) -> dict:
    """FIX 2: return (matched, rule, score). Rules mirror the API's
    compareNames priority: equal → contains → equal_suffixed → overlap.
    'overlap' requires ≥2 non-generic tokens in the intersection so
    "Nail Cafe" vs "Hair Cafe" (single-generic-token overlap) rejects.
    """
    raw_a = _normalize_name(stored)
    raw_b = _normalize_name(resolved)
    a = _strip_trailing_city(raw_a, city)
    b = _strip_trailing_city(raw_b, city)
    base = {'normalizedStored': a or raw_a, 'normalizedResolved': b or raw_b}
    if not a or not b:
        return {'match': False, 'rule': 'no_match', 'score': 0, **base}
    if a == b:
        return {'match': True, 'rule': 'equal', 'score': 1.0, **base}
    if a in b or b in a:
        return {'match': True, 'rule': 'contains', 'score': 1.0, **base}

    toks_a = _tokenize(a)
    toks_b = _tokenize(b)
    strip_a = _strip_trailing_suffixes(toks_a)
    strip_b = _strip_trailing_suffixes(toks_b)
    if (
        len(strip_a) >= 2 and len(strip_b) >= 2
        and ' '.join(strip_a) == ' '.join(strip_b)
    ):
        return {'match': True, 'rule': 'equal_suffixed', 'score': 0.95, **base}
    if (
        len(strip_a) >= 2 and len(strip_b) >= 2 and (
            ' '.join(toks_a) == ' '.join(strip_b)
            or ' '.join(toks_b) == ' '.join(strip_a)
        )
    ):
        return {'match': True, 'rule': 'equal_suffixed', 'score': 0.9, **base}

    set_a, set_b = set(toks_a), set(toks_b)
    if not set_a or not set_b:
        return {'match': False, 'rule': 'no_match', 'score': 0, **base}
    inter = set_a & set_b
    denom = min(len(set_a), len(set_b))
    ov = 0 if denom == 0 else len(inter) / denom
    non_generic = sum(1 for t in inter if t not in _GENERIC_TOKENS)
    interSole = next(iter(inter)) if len(inter) == 1 else None
    if (
        ov >= 0.6 and denom >= 2 and non_generic >= 2
        and not (len(inter) == 1 and interSole in _GENERIC_TOKENS)
    ):
        return {'match': True, 'rule': 'overlap', 'score': ov, **base}

    union = len(set_a) + len(set_b) - len(inter)
    jac = 0 if union == 0 else len(inter) / union
    if jac >= 0.6:
        return {'match': True, 'rule': 'jaccard', 'score': jac, **base}

    return {'match': False, 'rule': 'no_match', 'score': max(ov, jac), **base}

# ── Self-update plumbing ──────────────────────────────────────
# Version is read from version.json sitting next to main.py. A successful
# remote update overwrites this file, then we os.execv re-exec ONCE
# (loop-guard env flag) so the new code takes over without operator
# action. Cookies and .env are never touched by the updater.
BOT_DIR = Path(__file__).resolve().parent
VERSION_PATH = BOT_DIR / 'version.json'
UPDATE_FILES = (
    'main.py',
    'scraper_bulk.py',
    'email_scraper.py',
    'auto_setup_cookies.py',
    'requirements.txt',
    'version.json',
)
# Files the updater MUST NEVER overwrite — operator-local state.
UPDATE_PROTECTED = {'.env', 'google_cookies.json'}
SELF_UPDATE_DISABLED = (
    os.getenv('BOT_SELF_UPDATE', 'true').lower() == 'false'
)


def _read_local_version() -> str:
    try:
        with open(VERSION_PATH) as f:
            return str(json.load(f).get('version', '')).strip()
    except Exception:
        return ''


BOT_VERSION = _read_local_version() or 'unknown'

# Parallel pool for resolve_business jobs. Defaults are deliberately low
# so we stay under Google's rate-limit radar; bump via env on operators'
# call. Each worker shares ONE Chromium (per-job context, not per-job
# launch), and sleeps a jittered delay between jobs.
RESOLVE_WORKERS = max(1, int(os.getenv('RESOLVE_WORKERS', '3') or '3'))
RESOLVE_JITTER_MS = max(0, int(os.getenv('RESOLVE_JITTER_MS', '800') or '0'))

# Same knobs for the DISCOVERY_SEARCH parallel pool. Kept independent of
# RESOLVE_* so operators can throttle discovery separately (its per-job
# cost is lower — no hours read, no drill-in for tenant lists, single
# geo-anchored /maps/search hop for most candidates).
DISCOVERY_WORKERS = max(1, int(os.getenv('DISCOVERY_WORKERS', '3') or '3'))
DISCOVERY_JITTER_MS = max(0, int(os.getenv('DISCOVERY_JITTER_MS', '800') or '0'))


def load_cookies():
    """Read google_cookies.json into Playwright-compatible cookie dicts."""
    cookies = []
    if Path(GOOGLE_COOKIES_PATH).exists():
        with open(GOOGLE_COOKIES_PATH) as f:
            raw = json.load(f)
        for c in raw:
            ck = {
                'name': c.get('name', ''),
                'value': c.get('value', ''),
                'domain': c.get('domain', '.google.com'),
                'path': c.get('path', '/'),
            }
            if c.get('secure') is not None:
                ck['secure'] = bool(c['secure'])
            if c.get('httpOnly') is not None:
                ck['httpOnly'] = bool(c['httpOnly'])
            if c.get('sameSite') in ('Strict', 'Lax', 'None'):
                ck['sameSite'] = c['sameSite']
            exp = c.get('expires') or c.get('expirationDate')
            if exp and isinstance(exp, (int, float)) and exp > 0:
                ck['expires'] = int(exp)
            if ck['name'] and ck['value']:
                cookies.append(ck)
    return cookies


async def polling_loop():
    """Poll API for pending jobs and execute them."""
    logger.info(
        f'[POLL] Starting polling loop (every {POLL_INTERVAL}s)'
    )

    while True:
        try:
            await poll_and_execute()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f'[POLL] Loop error: {e}')

        await asyncio.sleep(POLL_INTERVAL)


async def poll_and_execute():
    """Check for a pending job and execute it."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f'{DOP_API_URL}/api/v1/seeding/bot/poll',
            headers={'x-bot-secret': DOP_WEBHOOK_SECRET},
        )

        if r.status_code != 200:
            return

        data = r.json()
        job = data.get('job')

        if not job:
            return  # No pending jobs

        job_id = str(job['_id'])
        job_type = job.get('type', 'gallery_menu')

        logger.info(
            f'[POLL] Got job {job_id}: '
            f'{job_type} for {job.get("businessName")}'
        )

        if job_type == 'gallery_menu':
            logger.info(
                f"[GALLERY] job addr: name={job.get('businessName')!r} "
                f"addr={job.get('addressLine1')!r} city={job.get('city')!r} "
                f"state={job.get('state')!r}"
            )

        req = ScrapeRequest(
            placeId=job.get('placeId', '') or '',
            businessId=job['businessId'],
            businessName=job.get('businessName', ''),
            environment=job['environment'],
            sessionId=job.get('sessionId') or None,
            skipReviews=(job_type != 'reviews'),
            skipGallery=(job_type != 'gallery_menu'),
            skipMenu=(job_type != 'gallery_menu'),
            maxReviews=job.get('maxReviews', 100),
            addressLine1=job.get('addressLine1', '') or '',
            address1=job.get('address1', '') or '',
            city=job.get('city', '') or '',
            state=job.get('state', '') or '',
            postalCode=job.get('postalCode', '') or '',
            latitude=job.get('latitude'),
            longitude=job.get('longitude'),
            website=job.get('website', '') or '',
        )

        try:
            if job_type == 'image_sync':
                await run_image_sync(req)
            elif job_type == 'cover_sync':
                await run_cover_sync(req)
            elif job_type == 'resolve_business':
                await run_resolve_business(req)
            elif job_type == 'email_scrape':
                await run_email_scrape_job(req)
            else:
                await run_scrape(req)

            async with httpx.AsyncClient(timeout=10) as c:
                await c.post(
                    f'{DOP_API_URL}/api/v1/seeding/bot/job/{job_id}/complete',
                    json={'success': True},
                    headers={'x-bot-secret': DOP_WEBHOOK_SECRET},
                )
        except Exception as e:
            logger.error(f'[POLL] Job {job_id} failed: {e}')
            async with httpx.AsyncClient(timeout=10) as c:
                await c.post(
                    f'{DOP_API_URL}/api/v1/seeding/bot/job/{job_id}/complete',
                    json={'success': False, 'error': str(e)},
                    headers={'x-bot-secret': DOP_WEBHOOK_SECRET},
                )


# ─── Request models ───────────────────────────────────────────

class ScrapeRequest(BaseModel):
    # placeId is optional for resolve_business jobs — those may run from
    # an address alone when no valid ChIJ is on record yet. Every other
    # path still requires it; the run_* functions guard.
    placeId: str = ""
    businessId: str
    businessName: Optional[str] = ""
    environment: str = "dev"
    sessionId: Optional[str] = None
    skipGallery: bool = False
    skipMenu: bool = False
    skipReviews: bool = False
    maxReviews: Optional[int] = None
    # Address fields carried for resolve_business — used to build a
    # Google Maps search URL when placeId is missing or invalid.
    addressLine1: Optional[str] = ""
    # Legacy field. Some older Business docs (pre split_address_line
    # backfill) still carry the street portion only under `address1`;
    # the bot uses it as a fallback when `addressLine1` is empty so
    # records with just the legacy field still build a viable query.
    address1: Optional[str] = ""
    city: Optional[str] = ""
    state: Optional[str] = ""
    postalCode: Optional[str] = ""
    # Coordinates — Fix 3 uses these to reject a stored city/state that
    # contradicts a domestic business (US bounds + non-US state).
    # Optional so non-resolve callers can omit them.
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    # Website URL carried for email_scrape — the business's own site
    # that we fetch to extract a literally-present email.
    website: Optional[str] = ""


class ScrapeStatusResponse(BaseModel):
    status: str
    message: str


# ─── In-memory job tracker ────────────────────────────────────

jobs: dict = {}  # placeId → { status, startedAt, error }


# ─── Health check ─────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "pinntag-bot",
        "cookiesPresent": Path(GOOGLE_COOKIES_PATH).exists(),
        "activeJobs": len([j for j in jobs.values()
                          if j["status"] == "running"]),
    }


# ─── Scrape endpoint ──────────────────────────────────────────

@app.post("/scrape", response_model=ScrapeStatusResponse)
async def trigger_scrape(
    req: ScrapeRequest,
    background_tasks: BackgroundTasks,
    x_bot_secret: Optional[str] = Header(None),
):
    if DOP_WEBHOOK_SECRET and x_bot_secret != DOP_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Invalid bot secret")

    if req.placeId in jobs and jobs[req.placeId]["status"] == "running":
        return ScrapeStatusResponse(
            status="already_running",
            message=f"Scrape already in progress for {req.placeId}"
        )

    jobs[req.placeId] = {
        "status": "running",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "error": None,
    }

    background_tasks.add_task(run_scrape, req)

    return ScrapeStatusResponse(
        status="started",
        message=f"Scrape started for {req.placeId}"
    )


@app.get("/scrape/{place_id}/status")
def scrape_status(place_id: str):
    job = jobs.get(place_id)
    if not job:
        return {"status": "not_found"}
    return job


@app.get("/profiles")
def list_profiles():
    import os
    from pathlib import Path
    import json

    user_data_dir = Path(CHROME_USER_DATA_DIR)
    profiles = []

    for entry in sorted(user_data_dir.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name not in ("Default",) and \
           not entry.name.startswith("Profile"):
            continue
        prefs_file = entry / "Preferences"
        if not prefs_file.exists():
            continue
        try:
            prefs = json.loads(
                prefs_file.read_text(
                    encoding="utf-8", errors="ignore"
                )
            )
            name = prefs.get("profile", {}).get("name", entry.name)
            acct = prefs.get("account_info", [])
            email = acct[0].get("email", "") if acct else ""
            profiles.append({
                "profile_dir": entry.name,
                "display_name": name,
                "email": email,
            })
        except Exception:
            profiles.append({
                "profile_dir": entry.name,
                "display_name": entry.name,
                "email": "",
            })

    return {
        "user_data_dir": str(user_data_dir),
        "profiles": profiles,
        "current": CHROME_PROFILE,
    }


# ─── Background scrape task ───────────────────────────────────

async def run_scrape(req: ScrapeRequest):
    try:
        from playwright.async_api import async_playwright

        cookies = load_cookies()
        logger.info(f'Cookies loaded: {len(cookies)} cookies')

        result = {
            "placeId": req.placeId,
            "businessId": req.businessId,
            "businessName": req.businessName,
            "environment": req.environment,
            "sessionId": req.sessionId,
            "scrapedAt": datetime.now(timezone.utc).isoformat(),
            "reviews": [],
            "gallery": [],
            "menu": [],
        }

        # Import scraper functions from scraper_bulk
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scraper_bulk import (
            scrape_menu,
            scrape_gallery,
            WorkerState,
        )

        # Create dummy dashboard for background task
        class SilentDashboard:
            async def update(self, state, **kwargs):
                pass

        state = WorkerState(worker_id=0)
        state.place_id = req.placeId
        state.place_name = req.businessName or ""
        dashboard = SilentDashboard()

        pid = req.placeId
        url = f"https://www.google.com/maps/place/?q=place_id:{pid}"
        logger.info(f"[GALLERY] entry url: {url}")

        # Phase 1: Gallery + Menu (headless)
        if not req.skipGallery or not req.skipMenu:
            async with async_playwright() as p:
                browser = await launch_browser(
                    p,
                    headless=False,
                    args=[
                        "--no-sandbox",
                        "--disable-blink-features=AutomationControlled",
                        "--disable-dev-shm-usage",
                        "--disable-gpu",
                        "--window-size=1280,900",
                        "--disable-extensions",
                        "--disable-plugins",
                        "--disable-javascript-harmony-shipping",
                        "--disable-background-timer-throttling",
                        "--disable-backgrounding-occluded-windows",
                        "--disable-renderer-backgrounding",
                        "--no-first-run",
                        "--no-default-browser-check",
                        "--disable-default-apps",
                    ],
                )
                logger.info(f'Browser launched for placeId={req.placeId}')
                context = await browser.new_context(
                    viewport={"width": 1280, "height": 900},
                    locale="en-US",
                    permissions=[],                 # grant nothing
                    geolocation=None,
                )
                # Explicitly deny geolocation for google.com so no popup blocks clicks.
                try:
                    await context.clear_permissions()
                except Exception:
                    pass

                # Override navigator.webdriver to hide automation
                await context.add_init_script("""
                    Object.defineProperty(navigator, 'webdriver', {
                        get: () => undefined
                    });
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [1, 2, 3, 4, 5]
                    });
                    Object.defineProperty(navigator, 'languages', {
                        get: () => ['en-US', 'en']
                    });
                    window.chrome = { runtime: {} };
                    Object.defineProperty(navigator, 'permissions', {
                        get: () => ({
                            query: (p) => Promise.resolve({ state: 'granted' })
                        })
                    });
                """)

                if cookies:
                    await context.add_cookies(cookies)

                page = await context.new_page()
                await page.goto(url, wait_until="domcontentloaded", timeout=40000)
                logger.info(f'Page loaded: {req.placeId} ({req.businessName})')

                # Dismiss consent
                for sel in [
                    'button[aria-label*="Accept all"]',
                    'button[aria-label*="Accept"]',
                    'button[aria-label*="Agree"]',
                ]:
                    try:
                        btn = page.locator(sel).first
                        if await btn.is_visible(timeout=1500):
                            await btn.click()
                            await page.wait_for_timeout(600)
                            break
                    except Exception:
                        pass

                await page.wait_for_timeout(4000)

                # Let the place panel hydrate. Bundled Chromium + clean
                # context land on the place card directly; we no longer
                # fight Street View bounces or pre-open the grid by hand —
                # scrape_gallery owns gallery entry via the Photos & videos
                # section.
                try:
                    await page.wait_for_selector(
                        'h1.DUwDvf, h1.fontHeadlineLarge', timeout=15000)
                    await page.wait_for_timeout(1500)
                except Exception:
                    logger.warning(
                        f"[GALLERY] place panel h1 never appeared — "
                        f"url={page.url[:140]}")

                # Diagnostic only: if the engine/context revert ever fails
                # and we still bounce into Street View, surface it in the
                # logs. No recovery dance — a clean landing is the fix.
                if "/@" in page.url and (",3a," in page.url
                        or "!1e1" in page.url or "!1e2" in page.url):
                    logger.warning(
                        f"[GALLERY] landed in Street View — url={page.url[:140]}")

                progress_cb = await make_progress_callback(
                    req.businessId, req.sessionId or ""
                )

                if not req.skipGallery:
                    try:
                        logger.info(f'Starting gallery scrape for {req.placeId}')
                        await send_progress(
                            req.businessId, req.sessionId or "",
                            "gallery", "started",
                            detail="Starting gallery scrape...",
                            folders_total=10,
                        )
                        result["gallery"] = await asyncio.wait_for(
                            scrape_gallery(
                                page, state, dashboard,
                                max_per_folder=MAX_GALLERY,
                                progress_callback=progress_cb,
                                already_open=False,
                            ),
                            timeout=180,
                        )
                        result["gallery"] = [
                            f for f in result["gallery"]
                            if f.get("folder_name", "").lower().strip()
                            not in SKIP_FOLDERS
                        ]
                        # ── portrait/selfie filter (gated; no-op while disabled) ──
                        from scraper_bulk import ENABLE_FACE_FILTER, _is_portrait
                        if ENABLE_FACE_FILTER:
                            import httpx as _httpx
                            sem = asyncio.Semaphore(8)
                            loop = asyncio.get_event_loop()

                            async def _keep(item) -> bool:
                                if item.get("type") == "video":
                                    return True
                                url = item.get("url", "")
                                if not url:
                                    return True
                                thumb = url.replace("=s0", "=s400") if "=s0" in url \
                                        else url + "=s400"
                                async with sem:
                                    try:
                                        async with _httpx.AsyncClient(timeout=8) as cx:
                                            r = await cx.get(thumb)
                                            if r.status_code != 200 or not r.content:
                                                return True
                                            is_face = await loop.run_in_executor(
                                                None, _is_portrait, r.content)
                                            return not is_face
                                    except Exception:
                                        return True

                            dropped = 0
                            for fobj in result["gallery"]:
                                media = fobj.get("media", [])
                                flags = await asyncio.gather(*[_keep(m) for m in media])
                                kept = [m for m, k in zip(media, flags) if k]
                                dropped += len(media) - len(kept)
                                fobj["media"] = kept
                            result["gallery"] = [
                                f for f in result["gallery"] if f.get("media")
                            ]
                            logger.info(f"[GALLERY] Portrait filter dropped {dropped} face images")
                        logger.info(
                            f'Gallery filtered: {len(result["gallery"])} folders kept — '
                            f'{[f.get("folder_name") for f in result["gallery"]]}'
                        )
                        logger.info(
                            f'Gallery done: '
                            f'{sum(len(f.get("media",[])) for f in result["gallery"])} '
                            f'images across {len(result["gallery"])} folders — '
                            f'{[f.get("folder_name") for f in result["gallery"]]}'
                        )
                        total_images = sum(
                            len(f.get("media", []))
                            for f in result["gallery"]
                        )
                        await send_progress(
                            req.businessId, req.sessionId or "",
                            "gallery", "done",
                            current=len(result["gallery"]),
                            total=total_images,
                            detail=f"{len(result['gallery'])} folders · {total_images} images",
                        )
                        await page.goto(url,
                            wait_until="domcontentloaded",
                            timeout=30000)
                        await page.wait_for_timeout(1500)
                    except asyncio.TimeoutError:
                        logger.warning("Gallery timed out")
                        result["gallery"] = []
                    except Exception as e:
                        logger.error(f"Gallery failed: {e}")
                        result["gallery"] = []

                if not req.skipMenu:
                    try:
                        logger.info(f'Starting menu scrape for {req.placeId}')
                        await send_progress(
                            req.businessId, req.sessionId or "",
                            "menu", "started",
                            detail="Starting menu scrape...",
                        )
                        result["menu"] = await asyncio.wait_for(
                            scrape_menu(page, state, dashboard),
                            timeout=30,
                        )
                        logger.info(
                            f'Menu done: {len(result["menu"])} items'
                        )
                        await send_progress(
                            req.businessId, req.sessionId or "",
                            "menu", "done",
                            current=len(result["menu"]),
                            detail=f"{len(result['menu'])} items found",
                        )
                    except asyncio.TimeoutError:
                        logger.warning("Menu timed out")
                        result["menu"] = []
                    except Exception as e:
                        logger.error(f"Menu failed: {e}")
                        result["menu"] = []

                await browser.close()

        # Phase 2: Reviews (Chrome profile)
        if not req.skipReviews:
            result["reviews"] = await run_reviews_scrape(req)

        # POST results back to DOP
        logger.info(
            f'Posting results to DOP webhook — '
            f'reviews={len(result["reviews"])} '
            f'gallery_folders={len(result["gallery"])} '
            f'menu_items={len(result["menu"])}'
        )
        await post_webhook(result)

        jobs[req.placeId] = {
            "status": "done",
            "startedAt": jobs.get(req.placeId, {}).get(
                "startedAt",
                datetime.now(timezone.utc).isoformat()
            ),
            "completedAt": datetime.now(timezone.utc).isoformat(),
            "reviewCount": len(result["reviews"]),
            "galleryFolders": len(result["gallery"]),
            "menuItems": len(result["menu"]),
            "error": None,
        }

    except Exception as e:
        import traceback
        logger.error(
            f'Scrape failed for {req.placeId}: {e}\n'
            f'{traceback.format_exc()}'
        )
        jobs[req.placeId] = {
            **jobs.get(req.placeId, {}),
            "status": "failed",
            "error": str(e),
        }
        # Notify DOP of failure
        await post_webhook({
            "placeId": req.placeId,
            "businessId": req.businessId,
            "environment": req.environment,
            "sessionId": req.sessionId,
            "error": str(e),
            "reviews": [],
            "gallery": [],
            "menu": [],
        })


async def run_reviews_scrape(req: ScrapeRequest):
    try:
        from playwright.async_api import async_playwright
        from scraper_bulk import (
            scrape_reviews,
            PlaceTask,
            WorkerState,
        )

        class SilentDashboard:
            async def update(self, state, **kwargs):
                pass

        state = WorkerState(worker_id=0)
        state.place_id = req.placeId
        state.place_name = req.businessName or ""
        dashboard = SilentDashboard()
        max_reviews = req.maxReviews or MAX_REVIEWS
        logger.info(
            f"Max reviews for this scrape: {max_reviews} "
            f"(from userRatingCount)"
        )

        cookies = load_cookies()

        logger.info(
            f"Starting reviews scrape with stealth Chromium "
            f"+ {len(cookies)} cookies for {req.placeId}"
        )

        async with async_playwright() as p:
            browser = await launch_browser(
                p,
                headless=False,
                args=[
                    "--no-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--window-size=1280,900",
                ],
            )

            context = await browser.new_context(
                viewport={"width": 1280, "height": 900},
                locale="en-US",
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                extra_http_headers={
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )

            # Stealth script
            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5]
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en']
                });
                window.chrome = { runtime: {} };
            """)

            if cookies:
                await context.add_cookies(cookies)

            page = await context.new_page()
            url = (
                f"https://www.google.com/maps/place/"
                f"?q=place_id:{req.placeId}"
            )

            logger.info(f"Navigating to: {url}")
            await page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=40000,
            )

            # Dismiss consent
            for sel in [
                'button[aria-label*="Accept all"]',
                'button[aria-label*="Accept"]',
                'button[aria-label*="Agree"]',
            ]:
                try:
                    btn = page.locator(sel).first
                    if await btn.is_visible(timeout=1500):
                        await btn.click()
                        await page.wait_for_timeout(600)
                        break
                except Exception:
                    pass

            await page.wait_for_timeout(4000)

            # Check if we can see the place
            try:
                title = await page.locator(
                    'h1.DUwDvf, h1.fontHeadlineLarge'
                ).first.inner_text(timeout=5000)
                logger.info(f"Place found: {title}")
            except Exception:
                logger.warning(
                    "Could not find place title — "
                    "page may not have loaded correctly"
                )

            task = PlaceTask(
                place_id=req.placeId,
                name=req.businessName or "",
                max_reviews=max_reviews,
            )

            await send_progress(
                req.businessId, req.sessionId or "",
                "reviews", "started",
                total=req.maxReviews or MAX_REVIEWS,
                detail="Starting reviews scrape...",
            )

            progress_cb = await make_progress_callback(
                req.businessId, req.sessionId or ""
            )

            reviews = await asyncio.wait_for(
                scrape_reviews(
                    page, task, state, dashboard,
                    sort="newest",
                    progress_callback=progress_cb,
                ),
                timeout=600,
            )

            await send_progress(
                req.businessId, req.sessionId or "",
                "reviews", "done",
                current=len(reviews),
                total=len(reviews),
                detail=f"{len(reviews)} reviews scraped",
            )

            await browser.close()

            logger.info(
                f"Reviews done: {len(reviews)} reviews "
                f"for {req.placeId}"
            )
            return reviews

    except asyncio.TimeoutError:
        logger.warning(
            f"Reviews timed out for {req.placeId}"
        )
        return []
    except Exception as e:
        import traceback
        logger.error(
            f"Reviews failed for {req.placeId}: "
            f"{e}\n{traceback.format_exc()}"
        )
        return []


async def run_cover_sync(req: ScrapeRequest):
    """Navigate to Google Maps and extract ONLY the cover image URL.

    Posts back via the existing webhook with `imageSync.cover` set and
    `imageSync.logo = None` — no logo selector chain, no website fallback,
    no gallery / menu / reviews work."""
    from playwright.async_api import async_playwright

    cookies = load_cookies()
    cover_url = None

    async with async_playwright() as p:
        browser = await launch_browser(
            p,
            headless=True,
            args=[
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
            ],
        )
        try:
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 900},
                locale='en-US',
                user_agent=(
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/124.0.0.0 Safari/537.36'
                ),
            )

            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """)

            if cookies:
                await context.add_cookies(cookies)

            page = await context.new_page()
            url = (
                f'https://www.google.com/maps/place/'
                f'?q=place_id:{req.placeId}'
            )

            logger.info(f'[cover_sync] Navigating to {url}')
            await page.goto(
                url,
                wait_until='domcontentloaded',
                timeout=30000,
            )
            await page.wait_for_timeout(3000)

            cover_url = await page.evaluate(r"""() => {
                const heroImg = document.querySelector(
                    'img.RZ66Rb.FgCUCc, ' +
                    'img[decoding="async"][src*="googleusercontent"], ' +
                    'button[jsaction*="heroHeaderImage"] img, ' +
                    'div.ZKbJif img, ' +
                    'img.p0AXBf'
                );
                if (heroImg) {
                    const src = heroImg.src ||
                        heroImg.getAttribute('data-src');
                    if (src && src.includes('googleusercontent'))
                        return src;
                }
                const imgs = document.querySelectorAll(
                    'img[src*="googleusercontent"]'
                );
                for (const img of imgs) {
                    if (img.width > 200 || img.height > 200) {
                        return img.src;
                    }
                }
                return null;
            }""")

            logger.info(
                f'[cover_sync] Results for {req.placeId}: '
                f'cover={"yes" if cover_url else "no"}'
            )
        except Exception as e:
            import traceback
            logger.error(
                f'[cover_sync] Browser block failed for {req.placeId}: '
                f'{e}\n{traceback.format_exc()}'
            )
            raise
        finally:
            await browser.close()

    result = {
        'placeId': req.placeId,
        'businessId': req.businessId,
        'businessName': req.businessName,
        'environment': req.environment,
        'sessionId': req.sessionId,
        'scrapedAt': datetime.now(timezone.utc).isoformat(),
        'imageSync': {
            'cover': cover_url,
            'logo': None,
        },
        'reviews': [],
        'gallery': [],
        'menu': [],
    }

    try:
        await post_webhook(result)
    except Exception as e:
        logger.error(
            f'[cover_sync] Webhook post failed for {req.placeId}: {e}'
        )
        raise


async def run_image_sync(req: ScrapeRequest):
    """Navigate to Google Maps and extract cover + logo image URLs.

    Posts back via the existing webhook with an `imageSync` field —
    no gallery / menu / reviews work is done here."""
    try:
        from playwright.async_api import async_playwright

        cookies = load_cookies()

        async with async_playwright() as p:
            browser = await launch_browser(
                p,
                headless=False,
                args=[
                    '--no-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                ],
            )
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 900},
                locale='en-US',
                user_agent=(
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/124.0.0.0 Safari/537.36'
                ),
            )

            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """)

            if cookies:
                await context.add_cookies(cookies)

            page = await context.new_page()
            url = (
                f'https://www.google.com/maps/place/'
                f'?q=place_id:{req.placeId}'
            )

            logger.info(f'[IMAGE_SYNC] Navigating to {url}')
            await page.goto(
                url,
                wait_until='domcontentloaded',
                timeout=30000,
            )
            await page.wait_for_timeout(3000)

            cover_url = await page.evaluate(r"""() => {
                const heroImg = document.querySelector(
                    'img.RZ66Rb.FgCUCc, ' +
                    'img[decoding="async"][src*="googleusercontent"], ' +
                    'button[jsaction*="heroHeaderImage"] img, ' +
                    'div.ZKbJif img, ' +
                    'img.p0AXBf'
                );
                if (heroImg) {
                    const src = heroImg.src ||
                        heroImg.getAttribute('data-src');
                    if (src && src.includes('googleusercontent'))
                        return src;
                }
                const imgs = document.querySelectorAll(
                    'img[src*="googleusercontent"]'
                );
                for (const img of imgs) {
                    if (img.width > 200 || img.height > 200) {
                        return img.src;
                    }
                }
                return null;
            }""")

            logo_url = await page.evaluate(r"""() => {
                const profileImg = document.querySelector(
                    'img.gm2-headline-5, ' +
                    'div.aoRNLd img, ' +
                    'img[data-src*="googleusercontent"][class*="profile"], ' +
                    'a[data-tooltip="Open website"] ~ img'
                );
                if (profileImg) {
                    const src = profileImg.src ||
                        profileImg.getAttribute('data-src');
                    if (src && src.includes('googleusercontent'))
                        return src;
                }
                return null;
            }""")

            # Fallback: try website og:image / favicon
            if not logo_url:
                try:
                    website_url = await page.evaluate(r"""() => {
                        const link = document.querySelector(
                            'a[data-item-id="authority"], ' +
                            'a[aria-label*="website"], ' +
                            'a[data-tooltip="Open website"]'
                        );
                        return link ? link.href : null;
                    }""")

                    if website_url:
                        web_page = await context.new_page()
                        try:
                            await web_page.goto(
                                website_url,
                                wait_until='domcontentloaded',
                                timeout=10000,
                            )
                            logo_url = await web_page.evaluate(r"""() => {
                                const og = document.querySelector(
                                    'meta[property="og:image"]'
                                );
                                if (og) return og.content;

                                const apple = document.querySelector(
                                    'link[rel="apple-touch-icon"]'
                                );
                                if (apple) {
                                    const href = apple.href;
                                    if (href.startsWith('http'))
                                        return href;
                                    return new URL(
                                        href, window.location.origin
                                    ).href;
                                }

                                const fav = document.querySelector(
                                    'link[rel*="icon"]'
                                );
                                if (fav) {
                                    const href = fav.href;
                                    if (href.startsWith('http'))
                                        return href;
                                    return new URL(
                                        href, window.location.origin
                                    ).href;
                                }

                                return null;
                            }""")
                        except Exception:
                            pass
                        finally:
                            await web_page.close()
                except Exception:
                    pass

            await browser.close()

            if not logo_url:
                logo_url = cover_url

            logger.info(
                f'[IMAGE_SYNC] Results for {req.placeId}: '
                f'cover={"yes" if cover_url else "no"}, '
                f'logo={"yes" if logo_url else "no"}'
            )

            result = {
                'placeId': req.placeId,
                'businessId': req.businessId,
                'businessName': req.businessName,
                'environment': req.environment,
                'sessionId': req.sessionId,
                'scrapedAt': datetime.now(
                    timezone.utc
                ).isoformat(),
                'imageSync': {
                    'cover': cover_url,
                    'logo': logo_url,
                },
                'reviews': [],
                'gallery': [],
                'menu': [],
            }

            await post_webhook(result)

    except Exception as e:
        import traceback
        logger.error(
            f'[IMAGE_SYNC] Failed for {req.placeId}: '
            f'{e}\n{traceback.format_exc()}'
        )


async def _resolve_make_context(browser, cookies):
    """Build a stealthy + cookie-loaded BrowserContext on the given browser.

    Used by BOTH the single-job path (one-shot Chromium) and the parallel
    worker pool (shared Chromium, per-job context). Mirrors what
    image_sync uses; resolve doesn't need a real Chrome profile.
    """
    context = await browser.new_context(
        viewport={'width': 1280, 'height': 900},
        locale='en-US',
        user_agent=(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/124.0.0.0 Safari/537.36'
        ),
    )
    await context.add_init_script("""
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined
        });
    """)
    if cookies:
        await context.add_cookies(cookies)
    return context


async def _resolve_in_context(context, req: 'ScrapeRequest'):
    """Run the full per-place resolve extraction on the given context.

    Opens a page, navigates to /maps/place/?q=place_id:<id> when we have
    a valid ChIJ, otherwise /maps/search/<address>. Waits for the panel
    h1 to hydrate, extracts name + placeId + hoursRaw, then closes the
    page (NOT the context — caller owns that).

    Returns a dict ready to merge into the resolve webhook body:
        { resolvedName, resolvedPlaceId, hoursRaw, error }
    The caller is responsible for adding businessId / environment /
    sessionId and POSTing to /resolve-business/webhook.
    """
    import re
    from urllib.parse import quote_plus

    resolved_name = None
    resolved_place_id = None
    hours_raw: list = []
    error_msg = None
    # Hoisted so the return at the bottom always has it bound, even
    # when the try-block crashes before the ChIJ search runs.
    place_id_note: str | None = None
    chij_source = 'none'
    chij_in_content = False
    # Extra-cheap fields captured on the same page visit. Same hoist
    # rule: must be bound even if extraction crashes — return uses them
    # unconditionally.
    rating: float | None = None
    user_rating_count: int | None = None
    cover_url: str | None = None
    google_category: str | None = None
    # Raw single-line Google formatted address — captured authentically
    # and shipped to the API as-is. Server-side parsing (libpostal)
    # decides whether to flag a proposedAddress or leave it as raw for
    # operator review. We never split it client-side: US "..., NY 11238,
    # United States" and India "..., Uttar Pradesh 201303" are
    # structurally different (country, glued postcode, variable city
    # position) so a hand-rolled splitter would fight reality.
    google_formatted_address: str | None = None
    # Which selector actually pulled the address (or None). Logged so we
    # can measure hit rate across a batch and swap the primary if the
    # DOM shifts.
    address_selector_used: str | None = None

    place_id_in = (req.placeId or '').strip()
    use_place_id = bool(re.match(r'^ChIJ[A-Za-z0-9_-]+$', place_id_in))
    has_name = bool((req.businessName or '').strip())

    # Viewport anchor for /maps/search/ URLs. Without it, Google ranks
    # results by requester IP — an operator machine in India searching a
    # bare-name query like "Eric house" resolves to a New Delhi housing
    # society, not the intended US POI. The @lat,lng,14z segment biases
    # ranking back into the business's own neighborhood; Google honors
    # the viewport for /maps/search/ (verified live).
    lat = getattr(req, 'latitude', None)
    lng = getattr(req, 'longitude', None)
    has_geo_anchor = (
        isinstance(lat, (int, float))
        and isinstance(lng, (int, float))
        and -90 <= float(lat) <= 90
        and -180 <= float(lng) <= 180
        and not (float(lat) == 0.0 and float(lng) == 0.0)
    )
    geo_anchor_suffix = (
        f'/@{float(lat)},{float(lng)},14z' if has_geo_anchor else ''
    )

    # Signal tier for the fallback search, best first:
    #   'coord' — viewport-anchored via @lat,lng,14z (Google honors it)
    #   'text'  — no coord anchor but city+state are in the query text,
    #             which biases Google's ranking away from operator IP
    #             even though it's a soft hint, not a hard viewport
    #   'none'  — name-only; drifts toward the requester's IP location.
    #             Logged distinctly so we can count how many jobs still
    #             fall through both tiers (data gap upstream).
    if has_geo_anchor:
        geo_signal = 'coord'
    elif (req.city or '').strip() and (req.state or '').strip():
        geo_signal = 'text'
    else:
        geo_signal = 'none'

    # PRIMARY: when we have a business name, search by name+address. The
    # placeIds we have on file are ADDRESS/BUILDING ids, not business
    # ids — navigating ?q=place_id:<id> opens the building's panel and
    # the "At this place" tenant DOM has been unreliable to scrape.
    # A name+address search lands on the business POI directly (or on a
    # short results list that we then click into below).
    #
    # nav_path tracks which URL strategy we used so the placeId echo /
    # sanity guards downstream can act accordingly.
    # FIX 3: sanitize the query fields BEFORE building the URL. See
    # module-top _sanitize_query_fields for the rules. Runs regardless
    # of whether the API already sanitized on its side — a job enqueued
    # via a path that skipped the API sanitizer must not poison the
    # Google search here.
    sanitized_q = _sanitize_query_fields(
        req.addressLine1, getattr(req, 'address1', ''),
        req.city, req.state,
        getattr(req, 'latitude', None),
        getattr(req, 'longitude', None),
    )
    sanitized_addr = sanitized_q['addressLine1']
    sanitized_city = sanitized_q['city']
    sanitized_state = sanitized_q['state']
    if sanitized_q['droppedReason'] or sanitized_q['droppedCityState']:
        logger.info(
            f'[RESOLVE-SANITIZE] {req.businessId} '
            f"reason={sanitized_q['droppedReason']} "
            f"cs={sanitized_q['droppedCityState']} "
            f"raw_a1={req.addressLine1!r} "
            f"→ a1={sanitized_addr!r} city={sanitized_city!r} "
            f"state={sanitized_state!r}"
        )

    nav_path = 'search'
    if has_name:
        query_parts = [
            (req.businessName or '').strip(),
            sanitized_addr,
            sanitized_city,
            sanitized_state,
        ]
        query = ' '.join([p for p in query_parts if p])
        if not query:
            return {
                'resolvedName': None,
                'resolvedPlaceId': None,
                'hoursRaw': [],
                'error': 'no_search_query',
            }
        target_url = (
            f'https://www.google.com/maps/search/{quote_plus(query)}'
            f'{geo_anchor_suffix}'
        )
    elif use_place_id:
        nav_path = 'place_id'
        target_url = (
            f'https://www.google.com/maps/place/'
            f'?q=place_id:{place_id_in}'
        )
    else:
        parts = [
            sanitized_addr,
            sanitized_city,
            sanitized_state,
            (req.postalCode or '').strip(),
        ]
        address = ', '.join([p for p in parts if p])
        if not address:
            return {
                'resolvedName': None,
                'resolvedPlaceId': None,
                'hoursRaw': [],
                'error': 'no_placeid_and_no_address',
            }
        target_url = (
            f'https://www.google.com/maps/search/'
            f'{quote_plus(address)}'
            f'{geo_anchor_suffix}'
        )

    logger.info(
        f'[RESOLVE] {req.businessId} nav_path={nav_path} '
        f'geo_anchor={"present" if has_geo_anchor else "missing"} '
        f'geo_signal={geo_signal} '
        f'→ {target_url[:160]}'
    )

    page = await context.new_page()
    try:
        await page.goto(
            target_url,
            wait_until='domcontentloaded',
            timeout=40000,
        )

        # Dismiss consent (same chain as run_scrape)
        for sel in [
            'button[aria-label*="Accept all"]',
            'button[aria-label*="Accept"]',
            'button[aria-label*="Agree"]',
        ]:
            try:
                btn = page.locator(sel).first
                if await btn.is_visible(timeout=1500):
                    await btn.click()
                    await page.wait_for_timeout(600)
                    break
            except Exception:
                pass

        # ── WAIT FOR THE PLACE PANEL TO HYDRATE ──
        # Bare sleeps were the bug: the right-hand panel finishes
        # rendering anywhere from 1.5s to 12s after consent. Wait
        # for the business h1 to actually exist, then give Maps
        # 1500ms more to swap any transient address-title for the
        # real business name (the place_id → search interstitial).
        h1_present = False
        try:
            await page.wait_for_selector(
                'h1.DUwDvf, h1.fontHeadlineLarge',
                timeout=15000,
            )
            h1_present = True
        except Exception:
            logger.info(
                f'[RESOLVE-DEBUG] {req.businessId} h1 never '
                f'appeared within 15s — page.url={page.url[:140]}'
            )

        # Extra settle so the h1 we read is the final one, not the
        # transient address title that briefly shows for some
        # place_id navigations.
        if h1_present:
            await page.wait_for_timeout(1500)

        # ── 1) resolvedName: re-read AFTER the settle ──
        if h1_present:
            try:
                resolved_name = (
                    await page.locator(
                        'h1.DUwDvf, h1.fontHeadlineLarge'
                    ).first.inner_text(timeout=5000)
                ).strip()
            except Exception:
                resolved_name = None
        else:
            resolved_name = None

        # Detect "h1 still shows the address we searched" — meaning we
        # landed on the BUILDING page, not the business. The placeIds
        # we were given are address/building placeIds, so navigating
        # ?q=place_id:<ChIJ> opens the building (e.g. "699 Broadway"),
        # and the real business (e.g. "Blink Nails") is a tenant in the
        # "At this place" section. We need to drill into it.
        address_for_compare = ', '.join([
            sanitized_addr,
            sanitized_city,
            sanitized_state,
        ]).strip(', ').lower()
        name_looks_like_address = bool(
            resolved_name
            and address_for_compare
            and (
                resolved_name.lower() in address_for_compare
                or address_for_compare in resolved_name.lower()
            )
        )

        # ── CLICK-THROUGH: search results / building → business POI ──
        # When the panel shows a results list (multiple search matches)
        # or a building (h1 is the searched address), find req.business
        # Name among the entries and navigate into that child place.
        # After the click-through, h1 becomes the business name and the
        # hours section actually has hours, so the existing extractor
        # below just works on whatever panel we end up on.
        landed_on = 'business'  # default if we don't need to click through
        atplace_entries_found = 0
        atplace_matched: Optional[str] = None
        atplace_best_score = 0
        drilled_in = False
        need_drill_in = (not resolved_name) or name_looks_like_address
        # Hoisted to outer scope so the discovery-aid log below can dump
        # the first few entries when we ended up unable to resolve.
        candidates: list = []

        if need_drill_in:
            # 'list' when we came via search and Google opened a results
            # list; 'building' when we came via place_id and got the
            # building's panel. Both need the same click-into-match flow.
            landed_on = 'list' if nav_path == 'search' else 'building'
            target_name = (req.businessName or '').strip()
            target_name_norm = re.sub(
                r'[^\w\s]', '', target_name.lower(),
            ).strip()
            target_tokens = (
                set(target_name_norm.split()) if target_name_norm else set()
            )

            if target_name_norm:
                try:
                    candidates = await page.evaluate(r"""() => {
                        // Collect tenant entries from the "At this place"
                        // list. Google renders them as anchors to other
                        // /maps/place/ URLs, either with aria-label
                        // carrying the business name or with the name as
                        // the first line of innerText. We try a few
                        // selectors and stop at the first that returns
                        // hits, so we don't pick up unrelated place
                        // links elsewhere on the page.
                        const out = [];
                        const seen = new Set();
                        const selectors = [
                            'a.hfpxzc[aria-label]',
                            'a[href*="/maps/place/"][aria-label]',
                            'div[role="feed"] a[href*="/maps/place/"]',
                            'div[role="article"] a[href*="/maps/place/"]',
                            'a[jsaction][href*="/maps/place/"]',
                        ];
                        for (const sel of selectors) {
                            const els = document.querySelectorAll(sel);
                            for (const el of els) {
                                const aria =
                                    el.getAttribute('aria-label') || '';
                                const inner = (
                                    el.innerText || el.textContent || ''
                                ).trim();
                                const raw =
                                    aria || inner.split('\n')[0];
                                const name = (raw || '').trim();
                                if (!name || name.length < 2) continue;
                                const href = el.href || '';
                                if (
                                    !href ||
                                    !href.includes('/maps/place/')
                                ) continue;
                                const key = name + '|' + href;
                                if (seen.has(key)) continue;
                                seen.add(key);
                                out.push({ name, href });
                            }
                            if (out.length > 0) break;
                        }
                        return out;
                    }""") or []
                except Exception:
                    candidates = []

            atplace_entries_found = len(candidates)
            best_entry = None
            best_rule = 'no_match'
            # FIX 2: score with the loosened match rule (equal / contains
            # / equal_suffixed / overlap-over-smaller with generic-token
            # guard) so we accept the same set of drill-in candidates the
            # API would accept post-webhook. Falls through to the old
            # token-overlap scorer only for candidates the loose match
            # doesn't confidently accept, so no candidate we USED to
            # accept can newly reject (monotonic loosening).
            for c in candidates:
                name = (c.get('name') or '').strip()
                if not name:
                    continue
                m = _names_loose_match(
                    target_name, name, city=req.city or None,
                )
                if m['match']:
                    # rule → score mapping: equal 100, contains 90,
                    # equal_suffixed 80, overlap/jaccard 60. Threshold
                    # below is >=50 so overlap+jaccard both clear.
                    score = {
                        'equal': 100, 'contains': 90,
                        'equal_suffixed': 80,
                        'overlap': 60, 'jaccard': 60,
                    }.get(m['rule'], 50)
                else:
                    # Legacy fallback: original max-set token overlap
                    # scoring. Kept so we don't newly reject anything
                    # the old code would have accepted.
                    name_norm = re.sub(
                        r'[^\w\s]', '', name.lower(),
                    ).strip()
                    name_tokens = (
                        set(name_norm.split()) if name_norm else set()
                    )
                    score = 0
                    if target_tokens and name_tokens:
                        overlap = len(name_tokens & target_tokens)
                        if overlap > 0:
                            denom = max(
                                len(name_tokens), len(target_tokens),
                            )
                            score = int((overlap / denom) * 60)

                if score > atplace_best_score:
                    atplace_best_score = score
                    best_entry = c
                    best_rule = m['rule'] if m['match'] else 'legacy'

            if best_entry and atplace_best_score >= 50:
                atplace_matched = best_entry.get('name')
                href = best_entry.get('href', '')
                logger.info(
                    f'[RESOLVE] {req.businessId} drill-in: '
                    f'matched "{atplace_matched}" '
                    f'(score={atplace_best_score}) → {href[:100]}'
                )
                try:
                    await page.goto(
                        href,
                        wait_until='domcontentloaded',
                        timeout=40000,
                    )
                    # Re-dismiss consent if it reappears on the child.
                    for sel in [
                        'button[aria-label*="Accept all"]',
                        'button[aria-label*="Accept"]',
                        'button[aria-label*="Agree"]',
                    ]:
                        try:
                            btn = page.locator(sel).first
                            if await btn.is_visible(timeout=1000):
                                await btn.click()
                                await page.wait_for_timeout(400)
                                break
                        except Exception:
                            pass

                    # Wait for the BUSINESS h1, then settle so any
                    # transient title is replaced with the final name.
                    try:
                        await page.wait_for_selector(
                            'h1.DUwDvf, h1.fontHeadlineLarge',
                            timeout=15000,
                        )
                        h1_present = True
                        await page.wait_for_timeout(1500)
                        landed_on = 'business'
                        drilled_in = True
                        try:
                            resolved_name = (
                                await page.locator(
                                    'h1.DUwDvf, h1.fontHeadlineLarge'
                                ).first.inner_text(timeout=5000)
                            ).strip()
                        except Exception:
                            resolved_name = None
                    except Exception:
                        logger.info(
                            f'[RESOLVE-DEBUG] {req.businessId} '
                            f'drill-in h1 never appeared within 15s — '
                            f'page.url={page.url[:140]}'
                        )
                except Exception as e:
                    logger.warning(
                        f'[RESOLVE] {req.businessId} drill-in '
                        f'navigation failed: {e}'
                    )
            else:
                # No confident result/tenant match. Search-path miss
                # means the name+address query returned only unrelated
                # places; place_id-path miss means the tenant list on
                # the building was either empty or unscrapable. Either
                # way, flag for review without writing.
                error_msg = (
                    'no_search_match'
                    if nav_path == 'search'
                    else 'business_not_listed_at_address'
                )
                logger.info(
                    f'[RESOLVE] {req.businessId} click-through: no '
                    f'confident match '
                    f'(entries={atplace_entries_found} '
                    f'best_score={atplace_best_score})'
                )

        # POST-CLICK-THROUGH GUARD: if after every attempt the h1 is
        # still the searched address (or never appeared), the business
        # was not actually resolved. Flag for review; the API gate will
        # leave the record alone. This catches the case where we did
        # click into a "best match" but landed somewhere that still
        # shows the building name.
        post_name_looks_like_address = bool(
            resolved_name
            and address_for_compare
            and (
                resolved_name.lower() in address_for_compare
                or address_for_compare in resolved_name.lower()
            )
        )
        if (
            nav_path == 'search'
            and not error_msg
            and ((not resolved_name) or post_name_looks_like_address)
        ):
            error_msg = 'business_not_found_by_search'

        # ── 2) resolvedPlaceId ──
        # If we DRILLED IN, the input placeId was the building, not the
        # business — discover the child's actual placeId from the new
        # page. If we did NOT drill (landed straight on the business
        # panel via /maps/place/?q=place_id), the comprehensive scan
        # below will still find a ChIJ in initstate; the input-echo
        # fallback at the bottom of this block only fires if nothing
        # was visible on the panel.
        resolved_place_id = None
        chij_in_content = False
        chij_source = 'none'

        # ── COMPREHENSIVE ChIJ SEARCH ──
        # Collect EVERY ChIJ visible on the resolved page from every
        # source, then pick the one most likely to be the BUSINESS
        # panel's id (not the input building id).
        #
        # Why we don't return-first-match anymore: when we drill into a
        # business from a building panel, the URL frequently still
        # contains the input building's ChIJ as a residual query param
        # while the business's ChIJ is only present in
        # window.APP_INITIALIZATION_STATE. The first-match-by-URL
        # regression was silently echoing the building id back.
        #
        # Source priority (best → worst):
        #   1) initstate  — Google's JS-side source of truth for the
        #                   currently-rendered panel
        #   2) url        — fast, but stale on search drill-ins
        #   3) script     — other inline JSON blobs
        #   4) content    — HTML serialisation (metas, anchors)
        #   5) dom        — data-pid / a[href] last-resort scan
        # Within a source we keep insertion order so a panel with
        # multiple anchors prefers the first.
        if h1_present:
            try:
                chij_dump = await page.evaluate(r"""() => {
                    const CHIJ = /ChIJ[A-Za-z0-9_-]{20,}/g;
                    const collect = (s) => {
                        if (!s) return [];
                        const m = String(s).match(CHIJ);
                        return m ? Array.from(m) : [];
                    };
                    const out = {
                        initstate: [],
                        url: [],
                        script: [],
                        content: [],
                        dom: [],
                    };
                    try {
                        const init = window.APP_INITIALIZATION_STATE;
                        if (init) {
                            out.initstate = collect(
                                JSON.stringify(init),
                            );
                        }
                    } catch (e) {}
                    try {
                        out.url = collect(location.href);
                    } catch (e) {}
                    try {
                        const scripts =
                            document.querySelectorAll('script');
                        for (const sc of scripts) {
                            for (const v of collect(sc.textContent)) {
                                out.script.push(v);
                            }
                        }
                    } catch (e) {}
                    try {
                        out.content = collect(
                            document.documentElement.outerHTML,
                        );
                    } catch (e) {}
                    try {
                        const main = document.querySelector(
                            'div[role="main"], div.bJzME',
                        );
                        if (main) {
                            for (const attr of [
                                'data-pid', 'data-place-id',
                            ]) {
                                const el = main.querySelector(
                                    `[${attr}]`,
                                );
                                if (el) {
                                    for (const v of collect(
                                        el.getAttribute(attr),
                                    )) {
                                        out.dom.push(v);
                                    }
                                }
                            }
                        }
                        const links = document.querySelectorAll(
                            'a[href*="/maps/place/"]',
                        );
                        for (const a of links) {
                            for (const v of collect(a.href)) {
                                out.dom.push(v);
                            }
                        }
                    } catch (e) {}
                    return out;
                }""")

                building_id = (place_id_in or '').strip()
                # When we drilled in or navigated via search, anything
                # equal to the input ChIJ is by definition NOT an
                # upgrade — skip it. When we navigated directly via
                # /maps/place/?q=place_id and didn't drill, the same
                # ChIJ being the only candidate just confirms the
                # input was already the business id; treat it as a
                # valid resolution (handled by the input-echo block
                # below if no other candidate hits first).
                drop_input = bool(
                    building_id and (drilled_in or nav_path == 'search')
                )
                source_order = (
                    'initstate', 'url', 'script', 'content', 'dom',
                )
                if isinstance(chij_dump, dict):
                    for src in source_order:
                        for cand in chij_dump.get(src, []) or []:
                            if not cand:
                                continue
                            if drop_input and cand == building_id:
                                continue
                            resolved_place_id = cand
                            chij_source = src
                            chij_in_content = True
                            break
                        if resolved_place_id:
                            break

                    # If we found NOTHING but the building id appeared
                    # repeatedly (search drilled into nowhere new),
                    # surface a soft note so the API can tag this as
                    # placeid_equals_building. Do NOT set error_msg —
                    # the hours scrape succeeded; the decouple must
                    # keep them as 'done'.
                    if (
                        not resolved_place_id
                        and drop_input
                        and any(
                            cand == building_id
                            for src in source_order
                            for cand in (chij_dump.get(src, []) or [])
                        )
                    ):
                        place_id_note = 'equals_building'
            except Exception:
                pass

        # Direct /maps/place/?q=place_id navs that didn't drill: when
        # the comprehensive scan above didn't surface a different ChIJ,
        # the input ChIJ IS the business id. Echo it.
        if (
            not resolved_place_id
            and h1_present
            and nav_path == 'place_id'
            and not drilled_in
            and not need_drill_in
        ):
            resolved_place_id = place_id_in
            chij_source = 'input'

        # ── 3) hoursRaw: expand panel first, then read table ──
        # The hours section is collapsed by default on many places.
        # Try a chain of expand-control selectors, click, settle,
        # THEN read the table rows. If the table still isn't there,
        # fall back to the aria-label on the hours summary button
        # (which lists the week's hours as comma-separated text).
        rows = []
        try:
            rows = await page.locator(
                'table.eK4R0e tr'
            ).all()
        except Exception:
            rows = []

        if not rows:
            for expand_sel in [
                'div[data-hide-tooltip-on-mouse-leave="true"] '
                'button',
                'div[data-hide-tooltip-on-mouse-leave] button',
                'button[aria-label*="hour" i]',
                'button[data-item-id*="oh"]',
                'div[aria-label*="hour" i]',
            ]:
                try:
                    btn = page.locator(expand_sel).first
                    if await btn.is_visible(timeout=1500):
                        await btn.click()
                        await page.wait_for_timeout(600)
                        rows = await page.locator(
                            'table.eK4R0e tr'
                        ).all()
                        if rows:
                            break
                except Exception:
                    continue

        # Read EVERY row regardless of current-day highlight, aria-current,
        # bold styling, or extra spans ("Open now", "Hours might differ")
        # in the cell. The previous reader keyed off two specific td
        # classes (ylH6lf / mxowUb) which Google swaps out for the
        # highlighted "today" row and the holiday-annotated row, so we
        # would silently drop 1-2 rows. Now we just take the row's tds
        # by position (1st = day label, 2nd = time text) and flatten any
        # nested span/badge content via inner_text + whitespace squash.
        if rows:
            for row in rows:
                try:
                    cells = await row.locator('td').all()
                    if len(cells) < 2:
                        continue
                    day_raw = (
                        await cells[0].inner_text(timeout=500)
                    ).strip()
                    time_raw = (
                        await cells[1].inner_text(timeout=500)
                    ).strip()
                    # Flatten badges/sublabels split across spans onto a
                    # single line. The API parser strips (Juneteenth) /
                    # "Hours might differ" — we just hand it the whole
                    # cell as a single line so it has everything to work
                    # with.
                    day = re.sub(r'\s+', ' ', day_raw).strip()
                    time_ = re.sub(r'\s+', ' ', time_raw).strip()
                    if day:
                        hours_raw.append(f'{day}: {time_}')
                except Exception:
                    pass

        # SAFETY LOG: if we captured fewer than 7 day-rows, dump the raw
        # innerText of the hours container so the next operator pass can
        # see what was present vs what we read. Common causes: a current-
        # day row using a sibling element instead of a <tr>, or Google
        # swapping table.eK4R0e for a new class.
        if len(hours_raw) < 7:
            try:
                container_text = await page.locator(
                    'table.eK4R0e'
                ).first.inner_text(timeout=1000)
            except Exception:
                container_text = ''
            logger.warning(
                f'[RESOLVE-HOURS-SHORT] {req.businessId} '
                f'emitted={len(hours_raw)} '
                f'rows={len(rows)} '
                f'container_text={container_text!r}'
            )

        # Aria-label fallback: when Google doesn't render the table
        # (e.g. compact panel), the hours summary button carries
        # the whole week as text like
        #   "Hours, Monday, 9 AM to 5 PM; Tuesday, ..."
        # Split on ';' into day chunks and reshape to "Day: time".
        if not hours_raw:
            try:
                aria = await page.locator(
                    'button[aria-label*="Hours" i], '
                    'div[aria-label*="Hours" i]'
                ).first.get_attribute('aria-label', timeout=1500)
                if aria:
                    # Strip the leading "Hours, " or "Hours; "
                    cleaned = re.sub(
                        r'^\s*hours[,;\s]+',
                        '',
                        aria,
                        flags=re.IGNORECASE,
                    )
                    # Day chunks are separated by ';' on most
                    # locales; fall back to '. ' if not found.
                    chunks = [
                        c.strip()
                        for c in (
                            cleaned.split(';')
                            if ';' in cleaned
                            else cleaned.split('. ')
                        )
                        if c.strip()
                    ]
                    DAYS = (
                        'sunday', 'monday', 'tuesday',
                        'wednesday', 'thursday', 'friday',
                        'saturday',
                    )
                    for chunk in chunks:
                        # "Monday, 9 AM to 5 PM" → "Monday: 9 AM-5 PM"
                        lower = chunk.lower()
                        if not any(
                            lower.startswith(d) for d in DAYS
                        ):
                            continue
                        parts = chunk.split(',', 1)
                        if len(parts) != 2:
                            continue
                        day = parts[0].strip()
                        time_ = parts[1].strip()
                        time_ = re.sub(
                            r'\s+to\s+',
                            '-',
                            time_,
                            flags=re.IGNORECASE,
                        )
                        hours_raw.append(f'{day}: {time_}')
            except Exception:
                pass

        # ── FIX 1: POST-HOURS TWO-HOP (recover-resolve-failures.md) ──
        # We landed on a business panel (h1 present, hours read
        # attempted) but hoursRaw came back empty. In the
        # 'no_hours_captured' cohort this is often because we're on a
        # low-info duplicate POI while the real hours-bearing panel is
        # one hop away via the "At this place" list or a
        # /maps/search/ results feed. Reuse the same click-through
        # selectors as the pre-hours drill-in; skip if we already
        # drilled once (page budget: max 2 navigations per business).
        did_two_hop = False
        two_hop_score = 0
        two_hop_matched: Optional[str] = None
        if (
            not hours_raw
            and not drilled_in
            and not error_msg
            and has_name
            and h1_present
        ):
            th_target = (req.businessName or '').strip()
            th_norm = re.sub(
                r'[^\w\s]', '', th_target.lower(),
            ).strip()
            th_tokens = (
                set(th_norm.split()) if th_norm else set()
            )
            th_candidates: list = []
            if th_norm:
                try:
                    th_candidates = await page.evaluate(r"""() => {
                        // Same selector chain as the pre-hours drill.
                        const out = [];
                        const seen = new Set();
                        const selectors = [
                            'a.hfpxzc[aria-label]',
                            'a[href*="/maps/place/"][aria-label]',
                            'div[role="feed"] a[href*="/maps/place/"]',
                            'div[role="article"] a[href*="/maps/place/"]',
                            'a[jsaction][href*="/maps/place/"]',
                        ];
                        const currentHref = location.href;
                        for (const sel of selectors) {
                            const els = document.querySelectorAll(sel);
                            for (const el of els) {
                                const aria =
                                    el.getAttribute('aria-label') || '';
                                const inner = (
                                    el.innerText || el.textContent || ''
                                ).trim();
                                const raw =
                                    aria || inner.split('\n')[0];
                                const name = (raw || '').trim();
                                if (!name || name.length < 2) continue;
                                const href = el.href || '';
                                if (
                                    !href ||
                                    !href.includes('/maps/place/')
                                ) continue;
                                // Skip self — clicking it is a no-op.
                                if (href === currentHref) continue;
                                const key = name + '|' + href;
                                if (seen.has(key)) continue;
                                seen.add(key);
                                out.push({ name, href });
                            }
                            if (out.length > 0) break;
                        }
                        return out;
                    }""") or []
                except Exception:
                    th_candidates = []

            th_best = None
            # FIX 2: same loosened match as the pre-hours drill-in above.
            # Legacy overlap kept as a fallback so this can only ever
            # accept a superset of what the old code accepted.
            for c in th_candidates:
                name = (c.get('name') or '').strip()
                if not name:
                    continue
                m = _names_loose_match(
                    th_target, name, city=req.city or None,
                )
                if m['match']:
                    score = {
                        'equal': 100, 'contains': 90,
                        'equal_suffixed': 80,
                        'overlap': 60, 'jaccard': 60,
                    }.get(m['rule'], 50)
                else:
                    name_norm = re.sub(
                        r'[^\w\s]', '', name.lower(),
                    ).strip()
                    name_tokens = (
                        set(name_norm.split()) if name_norm else set()
                    )
                    score = 0
                    if th_tokens and name_tokens:
                        overlap = len(name_tokens & th_tokens)
                        if overlap > 0:
                            denom = max(
                                len(name_tokens), len(th_tokens),
                            )
                            score = int((overlap / denom) * 60)
                if score > two_hop_score:
                    two_hop_score = score
                    th_best = c

            if th_best and two_hop_score >= 50:
                two_hop_matched = th_best.get('name')
                th_href = th_best.get('href', '')
                logger.info(
                    f'[RESOLVE] {req.businessId} two-hop: matched '
                    f'"{two_hop_matched}" (score={two_hop_score}) '
                    f'→ {th_href[:100]}'
                )
                try:
                    await page.goto(
                        th_href,
                        wait_until='domcontentloaded',
                        timeout=40000,
                    )
                    for sel in [
                        'button[aria-label*="Accept all"]',
                        'button[aria-label*="Accept"]',
                        'button[aria-label*="Agree"]',
                    ]:
                        try:
                            btn = page.locator(sel).first
                            if await btn.is_visible(timeout=1000):
                                await btn.click()
                                await page.wait_for_timeout(400)
                                break
                        except Exception:
                            pass
                    try:
                        await page.wait_for_selector(
                            'h1.DUwDvf, h1.fontHeadlineLarge',
                            timeout=15000,
                        )
                        await page.wait_for_timeout(1500)
                        did_two_hop = True
                        drilled_in = True
                        nav_path = 'two_hop'
                        landed_on = 'business'
                        try:
                            resolved_name = (
                                await page.locator(
                                    'h1.DUwDvf, h1.fontHeadlineLarge'
                                ).first.inner_text(timeout=5000)
                            ).strip()
                        except Exception:
                            pass
                        # Re-read hours on the new panel.
                        rows_2 = []
                        try:
                            rows_2 = await page.locator(
                                'table.eK4R0e tr'
                            ).all()
                        except Exception:
                            rows_2 = []
                        if not rows_2:
                            for expand_sel in [
                                'div[data-hide-tooltip-on-mouse-leave="true"] '
                                'button',
                                'div[data-hide-tooltip-on-mouse-leave] button',
                                'button[aria-label*="hour" i]',
                                'button[data-item-id*="oh"]',
                                'div[aria-label*="hour" i]',
                            ]:
                                try:
                                    btn = page.locator(
                                        expand_sel,
                                    ).first
                                    if await btn.is_visible(timeout=1500):
                                        await btn.click()
                                        await page.wait_for_timeout(600)
                                        rows_2 = await page.locator(
                                            'table.eK4R0e tr'
                                        ).all()
                                        if rows_2:
                                            break
                                except Exception:
                                    continue
                        if rows_2:
                            for row in rows_2:
                                try:
                                    cells = await row.locator('td').all()
                                    if len(cells) < 2:
                                        continue
                                    day_raw = (
                                        await cells[0].inner_text(
                                            timeout=500,
                                        )
                                    ).strip()
                                    time_raw = (
                                        await cells[1].inner_text(
                                            timeout=500,
                                        )
                                    ).strip()
                                    day = re.sub(
                                        r'\s+', ' ', day_raw,
                                    ).strip()
                                    time_ = re.sub(
                                        r'\s+', ' ', time_raw,
                                    ).strip()
                                    if day:
                                        hours_raw.append(
                                            f'{day}: {time_}',
                                        )
                                except Exception:
                                    pass
                        # Re-scan ChIJ from the child panel — this is
                        # the real business ChIJ (not the building's).
                        try:
                            chij_dump_2 = await page.evaluate(r"""() => {
                                const CHIJ = /ChIJ[A-Za-z0-9_-]{20,}/g;
                                const collect = (s) => {
                                    if (!s) return [];
                                    const m = String(s).match(CHIJ);
                                    return m ? Array.from(m) : [];
                                };
                                const out = {
                                    initstate: [], url: [], content: [],
                                };
                                try {
                                    const init = window.APP_INITIALIZATION_STATE;
                                    if (init) out.initstate = collect(
                                        JSON.stringify(init),
                                    );
                                } catch (e) {}
                                try {
                                    out.url = collect(location.href);
                                } catch (e) {}
                                try {
                                    out.content = collect(
                                        document.documentElement.outerHTML,
                                    );
                                } catch (e) {}
                                return out;
                            }""")
                            building_id = (place_id_in or '').strip()
                            for src in ('initstate', 'url', 'content'):
                                for cand in (chij_dump_2 or {}).get(
                                    src, [],
                                ) or []:
                                    if not cand:
                                        continue
                                    if (
                                        building_id
                                        and cand == building_id
                                    ):
                                        continue
                                    resolved_place_id = cand
                                    chij_source = f'two_hop:{src}'
                                    chij_in_content = True
                                    # A real business ChIJ was found
                                    # — clear the earlier
                                    # equals_building note.
                                    place_id_note = None
                                    break
                                if (
                                    resolved_place_id
                                    and resolved_place_id != building_id
                                ):
                                    break
                        except Exception:
                            pass
                    except Exception:
                        logger.info(
                            f'[RESOLVE-DEBUG] {req.businessId} two-hop '
                            f'h1 never appeared within 15s'
                        )
                except Exception as e:
                    logger.warning(
                        f'[RESOLVE] {req.businessId} two-hop nav '
                        f'failed: {e}'
                    )
            elif th_candidates:
                logger.info(
                    f'[RESOLVE] {req.businessId} two-hop: no confident '
                    f'match (entries={len(th_candidates)} '
                    f'best_score={two_hop_score})'
                )

        # ── 4) Extra-cheap reads off the same panel ──
        # rating, userRatingCount and cover URL are all visible on the
        # same DOM we already loaded for hours/placeId; pull them in
        # the same visit so we don't pay another Google nav for them.
        # Selectors reused from scraper_bulk.SEL (rating/review_count)
        # and from cover_sync (hero img chain). The cover URL is the
        # RAW Google googleusercontent URL — we DO NOT download/upload
        # to B2 here; the API queues that on a separate sync job.
        try:
            r_txt = await page.locator(
                'div.F7nice span[aria-hidden="true"]'
            ).first.inner_text(timeout=800)
            if r_txt:
                try:
                    rating = float(r_txt.strip().replace(',', '.'))
                except ValueError:
                    rating = None
        except Exception:
            pass
        try:
            rc_txt = await page.locator(
                'div.F7nice span[aria-label*="review"]'
            ).first.inner_text(timeout=800)
            if rc_txt:
                digits = re.sub(r'[^\d]', '', rc_txt)
                user_rating_count = int(digits) if digits else None
        except Exception:
            pass
        # Mirror the cover_sync hero selector chain verbatim, including
        # the >200px fallback scan. Returns the FIRST googleusercontent
        # URL we find — the API webhook stores it as pendingCoverUrl
        # when no cover is set yet.
        try:
            cover_url = await page.evaluate(r"""() => {
                const heroImg = document.querySelector(
                    'img.RZ66Rb.FgCUCc, ' +
                    'img[decoding="async"][src*="googleusercontent"], ' +
                    'button[jsaction*="heroHeaderImage"] img, ' +
                    'div.ZKbJif img, ' +
                    'img.p0AXBf'
                );
                if (heroImg) {
                    const src = heroImg.src ||
                        heroImg.getAttribute('data-src');
                    if (src && src.includes('googleusercontent'))
                        return src;
                }
                const imgs = document.querySelectorAll(
                    'img[src*="googleusercontent"]'
                );
                for (const img of imgs) {
                    if (img.width > 200 || img.height > 200) {
                        return img.src;
                    }
                }
                return null;
            }""")
        except Exception:
            cover_url = None

        # Google category — the small line under the business name
        # ("Nail salon", "Hair salon", etc.). Selector chain in priority
        # order; same selectors scraper_bulk uses (button.DkEaL) plus
        # the jsaction-based locator that survives class renames, and
        # the .skqShb fallback for the newer category chip layout.
        # Cheap read; failure here never blocks hours/rating/cover.
        for cat_sel in (
            'button[jsaction*="category"]',
            'button.DkEaL',
            'span.skqShb',
            'div.skqShb',
        ):
            try:
                cat_txt = await page.locator(
                    cat_sel,
                ).first.inner_text(timeout=600)
                if cat_txt and cat_txt.strip():
                    google_category = re.sub(
                        r'\s+', ' ', cat_txt,
                    ).strip()
                    break
            except Exception:
                continue

        # Google formatted address — full single-line raw string.
        # Primary: address button's inner fontBodyMedium div (the
        # rendered text). Fallback: aria-label on the address button
        # itself, which typically looks like
        #   "Address: 927 Fulton St, Brooklyn, NY 11238, United States"
        # — strip the "Address:" prefix. Both anchor on
        # data-item-id="address" (stable attribute) rather than a
        # fragile class chain. Cheap read; failure never blocks
        # hours/rating/cover/category.
        try:
            addr_txt = await page.locator(
                'button[data-item-id="address"] div.fontBodyMedium',
            ).first.inner_text(timeout=800)
            if addr_txt and addr_txt.strip():
                google_formatted_address = re.sub(
                    r'\s+', ' ', addr_txt,
                ).strip()
                address_selector_used = 'button.fontBodyMedium'
        except Exception:
            pass

        if not google_formatted_address:
            try:
                aria = await page.locator(
                    'button[data-item-id="address"]',
                ).first.get_attribute(
                    'aria-label', timeout=800,
                )
                if aria:
                    cleaned = re.sub(
                        r'^\s*address[:,\s]+',
                        '',
                        aria,
                        flags=re.IGNORECASE,
                    )
                    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
                    if cleaned:
                        google_formatted_address = cleaned
                        address_selector_used = 'button.aria-label'
            except Exception:
                pass

        # ── DEBUG: enough state to diagnose any future failure ──
        try:
            first_h1_raw = (
                await page.locator(
                    'h1.DUwDvf, h1.fontHeadlineLarge'
                ).first.inner_text(timeout=500)
            ).strip() if h1_present else ''
        except Exception:
            first_h1_raw = ''

        # Discovery aid: when we couldn't resolve a business (no id, or
        # an address-looking h1) and Google did return result entries,
        # dump the first 3 names so the next operator pass can see what
        # came back without re-running this place.
        final_address_like = bool(
            resolved_name
            and address_for_compare
            and (
                resolved_name.lower() in address_for_compare
                or address_for_compare in resolved_name.lower()
            )
        )
        if (
            ((not resolved_name) or final_address_like or not resolved_place_id)
            and atplace_entries_found > 0
        ):
            first_3 = [
                (c.get('name') or '')[:80]
                for c in candidates[:3]
            ]
            logger.info(
                f'[RESOLVE-MISS] {req.businessId} '
                f'nav_path={nav_path} '
                f'entries={atplace_entries_found} '
                f'first_3={first_3}'
            )

        logger.info(
            f'[RESOLVE-DEBUG] {req.businessId} '
            f'url={page.url[:140]} '
            f'h1_present={h1_present} '
            f'h1_raw="{first_h1_raw}" '
            f'name_looks_like_address={name_looks_like_address} '
            f'nav_path={nav_path} '
            f'landed_on={landed_on} '
            f'drilled_in={drilled_in} '
            f'did_two_hop={did_two_hop} '
            f'two_hop_score={two_hop_score} '
            f'two_hop_matched={two_hop_matched!r} '
            f'atplace_entries_found={atplace_entries_found} '
            f'atplace_matched={atplace_matched!r} '
            f'atplace_best_score={atplace_best_score} '
            f'hours_rows={len(rows)} '
            f'hours_emitted={len(hours_raw)} '
            f'chij_source={chij_source} '
            f'chij_in_content={chij_in_content} '
            f'use_place_id={use_place_id}'
        )

        logger.info(
            f'[RESOLVE] {req.businessId} '
            f'name="{resolved_name}" '
            f'placeId={resolved_place_id} '
            f'chij_source={chij_source} '
            f'place_id_note={place_id_note} '
            f'building_id_in={place_id_in} '
            f'hours={len(hours_raw)} '
            f'rating={rating} '
            f'userRatingCount={user_rating_count} '
            f'coverUrl={"yes" if cover_url else "no"} '
            f'googleCategory={google_category!r} '
            f'googleFormattedAddress='
            f'{"yes" if google_formatted_address else "no"} '
            f'addressSelector={address_selector_used or "none"}'
        )

    except Exception as e:
        import traceback
        error_msg = f'{type(e).__name__}: {e}'
        logger.error(
            f'[RESOLVE] Failed for {req.businessId}: '
            f'{e}\n{traceback.format_exc()}'
        )
    finally:
        try:
            await page.close()
        except Exception:
            pass

    # ── STATE CROSS-VALIDATION (Check A) ──
    # The API's country-only guard is too coarse: "Atlanta, GA" vs
    # "Los Angeles, CA" is same-country, wrong business, and slips
    # through today. Compare resolved state (parsed from Google's
    # formatted address) against the stored state on the job. Applies
    # to every path — place_id, two_hop, and the fallback search — by
    # firing at the single return point below.
    #
    # On mismatch: null hoursRaw/placeId and set error='state_mismatch'.
    # The API webhook (resolve.service.ts ~654) treats error != null as
    # a bot failure — writes resolveStatus.reason='bot_error:state_mismatch',
    # hours/placeId='review:bot_error:state_mismatch', and skips ALL
    # per-field writes (hours, placeId, cover, category, rating).
    # Skipped when either side is empty: no signal, no verdict — never
    # a false positive.
    stored_state_norm = _normalize_state(req.state)
    resolved_state_norm = _extract_state_from_formatted(
        google_formatted_address,
    )
    state_mismatch = (
        stored_state_norm
        and resolved_state_norm
        and stored_state_norm != resolved_state_norm
        and (resolved_name or resolved_place_id)
    )
    if state_mismatch:
        logger.warning(
            f'[RESOLVE-STATE-MISMATCH] {req.businessId} '
            f'stored={stored_state_norm} '
            f'resolved={resolved_state_norm} '
            f'name={resolved_name!r} '
            f'addr={google_formatted_address!r}'
        )
        return {
            'resolvedName': resolved_name,
            'resolvedPlaceId': None,
            'hoursRaw': [],
            'navPath': nav_path,
            'placeIdNote': None,
            'rating': None,
            'userRatingCount': None,
            'coverUrl': None,
            'googleCategory': None,
            'googleFormattedAddress': google_formatted_address,
            'addressSync': None,
            'error': 'state_mismatch',
        }

    return {
        'resolvedName': resolved_name,
        'resolvedPlaceId': resolved_place_id,
        'hoursRaw': hours_raw,
        # 'search' | 'place_id' | 'two_hop'. two_hop signals to the
        # API webhook that this run navigated a second time to reach
        # the hours-bearing panel.
        'navPath': nav_path,
        # Soft note for the API decouple — set when search/drilled-in
        # surfaced ONLY the input building id (no business-level ChIJ
        # was visible). API maps this to placeId='review:placeid_equals_building'
        # but leaves hours='done' and the stored placeId untouched.
        'placeIdNote': place_id_note,
        # Extra-cheap fields captured on the same panel. Each is
        # independently decoupled on the API side — a None for any of
        # them just means "not captured this run", never blocks the
        # others or the hours write.
        'rating': rating,
        'userRatingCount': user_rating_count,
        'coverUrl': cover_url,
        'googleCategory': google_category,
        # Raw single-line; API libpostal-parses (or flags for operator
        # review when libpostal is unavailable). Never split here.
        'googleFormattedAddress': google_formatted_address,
        # New: address write-back block. `formattedAddress` is what the
        # API pushes onto addressLine1 (through sanitizeBusinessPatch,
        # which owns validation + city derivation). `googleName` backs
        # verified_name / c11 later — capture now while we're on the
        # page, even though c11 isn't scored yet.
        'addressSync': {
            'formattedAddress': google_formatted_address,
            'googleName': resolved_name,
        },
        'error': error_msg,
    }


async def run_resolve_business(req: ScrapeRequest):
    """Single-job entry point — launches a one-shot Chromium for this
    one resolve and posts the webhook. Kept for safety / single /bot/poll
    callers; the high-throughput path is resolve_pool_loop, which shares
    one browser across RESOLVE_WORKERS workers.
    """
    from playwright.async_api import async_playwright

    cookies = load_cookies()
    payload: dict = {
        'resolvedName': None,
        'resolvedPlaceId': None,
        'hoursRaw': [],
        'error': None,
    }

    async with async_playwright() as p:
        browser = await launch_browser(
            p,
            headless=True,
            args=[
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
            ],
        )
        try:
            context = await _resolve_make_context(browser, cookies)
            try:
                payload = await _resolve_in_context(context, req)
            finally:
                try:
                    await context.close()
                except Exception:
                    pass
        finally:
            try:
                await browser.close()
            except Exception:
                pass

    await post_resolve_webhook({
        'businessId': req.businessId,
        'environment': req.environment,
        'sessionId': req.sessionId,
        **payload,
    })


# ─── Parallel resolve_business worker pool ────────────────────────
#
# The serial path (~7s/place via /bot/poll) takes ~17h for 9k businesses.
# The pool shares ONE Chromium across N workers (per-job context, not
# per-job browser launch — the launch is most of the per-job latency),
# claims jobs in atomic batches via /bot/poll-batch, and sleeps a jittered
# delay between jobs so requests don't form a regular burst that's easy
# for Google to rate-limit. Workers are persistent across batches; the
# loop polls again as soon as the current batch drains.

async def _poll_resolve_batch(limit: int) -> list:
    """Atomically claim up to `limit` resolve_business jobs from the API."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f'{DOP_API_URL}/api/v1/seeding/bot/poll-batch',
                params={'type': 'resolve_business', 'limit': limit},
                headers={'x-bot-secret': DOP_WEBHOOK_SECRET},
            )
    except Exception as e:
        logger.warning(f'[RESOLVE-POOL] poll-batch request failed: {e}')
        return []

    if r.status_code != 200:
        logger.warning(
            f'[RESOLVE-POOL] poll-batch HTTP {r.status_code}: '
            f'{r.text[:160]}'
        )
        return []

    try:
        data = r.json()
    except Exception:
        return []
    return data.get('jobs') or []


async def _post_resolve_and_get_status(data: dict) -> str:
    """Like post_resolve_webhook, but returns 'done' | 'review' | 'error'
    so the worker can attribute outcomes for the per-batch summary log.
    The API decides done vs. review via its confidence + hours gate.
    """
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f'{DOP_API_URL}/api/v1/seeding/resolve-business/webhook',
                json=data,
                headers={
                    'Content-Type': 'application/json',
                    'x-bot-secret': DOP_WEBHOOK_SECRET,
                },
            )
            if response.status_code in (200, 201):
                logger.info(
                    f'[RESOLVE] Webhook delivered for '
                    f'{data.get("businessId")}'
                )
                try:
                    body = response.json()
                except Exception:
                    body = {}
                status = body.get('status') if isinstance(body, dict) else None
                if status in ('done', 'review'):
                    return status
                return 'done'
            logger.error(
                f'[RESOLVE] Webhook failed '
                f'{response.status_code}: '
                f'{response.text[:200]}'
            )
            return 'error'
    except Exception as e:
        logger.error(
            f'[RESOLVE] Webhook POST failed: '
            f'{type(e).__name__}: {e}'
        )
        return 'error'


async def _resolve_worker(
    worker_id: int,
    queue: 'asyncio.Queue',
    browser,
    cookies,
    jitter_ms: int,
):
    """Persistent worker: pull (job, stats) off the queue, run one
    resolve on a fresh context off the shared browser, post the webhook
    + job/complete, tally outcome, sleep jittered, repeat.

    A failure inside a single job does NOT propagate — the worker marks
    that job failed and moves on, so one bad page can't kill the batch.
    """
    while True:
        job, stats = await queue.get()
        job_id = str(job.get('_id') or '')
        success = False
        review = False
        error_msg: Optional[str] = None
        try:
            req = ScrapeRequest(
                placeId=job.get('placeId', '') or '',
                businessId=job['businessId'],
                businessName=job.get('businessName', ''),
                environment=job['environment'],
                sessionId=job.get('sessionId') or None,
                skipReviews=True,
                skipGallery=True,
                skipMenu=True,
                maxReviews=job.get('maxReviews', 100),
                addressLine1=job.get('addressLine1', '') or '',
                address1=job.get('address1', '') or '',
                city=job.get('city', '') or '',
                state=job.get('state', '') or '',
                postalCode=job.get('postalCode', '') or '',
                latitude=job.get('latitude'),
                longitude=job.get('longitude'),
            )

            context = await _resolve_make_context(browser, cookies)
            try:
                payload = await _resolve_in_context(context, req)
            finally:
                try:
                    await context.close()
                except Exception:
                    pass

            webhook_status = await _post_resolve_and_get_status({
                'businessId': req.businessId,
                'environment': req.environment,
                'sessionId': req.sessionId,
                **payload,
            })
            if webhook_status == 'error':
                error_msg = 'webhook_error'
            else:
                success = True
                review = (webhook_status == 'review')
        except asyncio.CancelledError:
            raise
        except Exception as e:
            error_msg = f'{type(e).__name__}: {e}'
            logger.error(
                f'[RESOLVE-POOL] worker {worker_id} '
                f'job {job_id} failed: {error_msg}'
            )

        # Always mark the job complete (success or fail) so it doesn't
        # sit forever in 'running'. resetStuckJobs would eventually free
        # it, but completing here is the well-behaved path.
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                await c.post(
                    f'{DOP_API_URL}/api/v1/seeding/bot/job/'
                    f'{job_id}/complete',
                    json={
                        'success': bool(success),
                        'error': error_msg,
                    },
                    headers={'x-bot-secret': DOP_WEBHOOK_SECRET},
                )
        except Exception as e:
            logger.warning(
                f'[RESOLVE-POOL] worker {worker_id} '
                f'job/complete post failed: {e}'
            )

        if not success:
            stats['failed'] += 1
        elif review:
            stats['review'] += 1
        else:
            stats['done'] += 1

        queue.task_done()

        # Jittered pacing — keep request cadence irregular so the pool
        # doesn't look like a uniform burst. 0.5x–1.5x of RESOLVE_JITTER_MS.
        if jitter_ms > 0:
            try:
                delay = random.uniform(
                    jitter_ms * 0.5, jitter_ms * 1.5,
                ) / 1000.0
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                raise


async def resolve_pool_loop():
    """Top-level pool loop: claim a batch, dispatch across workers, log
    a per-batch summary, repeat. The shared Chromium is launched lazily
    on the first non-empty batch and reused across all subsequent batches
    (relaunch-per-job was a big chunk of the serial path's latency).
    """
    logger.info(
        f'[RESOLVE-POOL] Starting (workers={RESOLVE_WORKERS} '
        f'jitter_ms={RESOLVE_JITTER_MS})'
    )

    from playwright.async_api import async_playwright

    cookies = load_cookies()
    queue: asyncio.Queue = asyncio.Queue()
    worker_tasks: list = []
    pw = None
    browser = None

    try:
        pw = await async_playwright().start()
        while True:
            try:
                jobs = await _poll_resolve_batch(RESOLVE_WORKERS)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f'[RESOLVE-POOL] poll-batch failed: {e}')
                await asyncio.sleep(POLL_INTERVAL)
                continue

            if not jobs:
                await asyncio.sleep(POLL_INTERVAL)
                continue

            # Lazy-launch the shared browser the first time we have real
            # work. If launch fails, we leave the claimed jobs in
            # 'running'; resetStuckJobs flips them back to pending after
            # 10 minutes so a crashed pod doesn't strand them.
            if browser is None:
                try:
                    browser = await launch_browser(
                        pw,
                        headless=HEADLESS,
                        args=[
                            '--no-sandbox',
                            '--disable-blink-features=AutomationControlled',
                            '--disable-dev-shm-usage',
                        ],
                    )
                    logger.info('[RESOLVE-POOL] Shared Chromium launched')
                except Exception as e:
                    logger.error(
                        f'[RESOLVE-POOL] Chromium launch failed: {e}'
                    )
                    await asyncio.sleep(POLL_INTERVAL)
                    continue

            if not worker_tasks:
                worker_tasks = [
                    asyncio.create_task(
                        _resolve_worker(
                            i, queue, browser, cookies, RESOLVE_JITTER_MS,
                        )
                    )
                    for i in range(RESOLVE_WORKERS)
                ]

            batch_start = time.time()
            stats = {'done': 0, 'review': 0, 'failed': 0}
            claimed = len(jobs)
            logger.info(
                f'[RESOLVE-POOL] Batch claimed: {claimed} '
                f'job(s)'
            )

            for job in jobs:
                await queue.put((job, stats))

            await queue.join()

            elapsed = time.time() - batch_start
            logger.info(
                f'[RESOLVE-POOL] Batch done — claimed={claimed} '
                f'done={stats["done"]} review={stats["review"]} '
                f'failed={stats["failed"]} '
                f'elapsed={elapsed:.1f}s'
            )
    except asyncio.CancelledError:
        raise
    finally:
        for t in worker_tasks:
            t.cancel()
        for t in worker_tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass
        if pw is not None:
            try:
                await pw.stop()
            except Exception:
                pass


async def post_resolve_webhook(data: dict):
    """POST resolve results to the API's dedicated resolve webhook.

    Separate from the regular /bot/webhook so the API never has to
    sniff which kind of payload it's looking at; resolve has its own
    handler with the confidence gate + hours parser.
    """
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{DOP_API_URL}/api/v1/seeding/resolve-business/webhook",
                json=data,
                headers={
                    "Content-Type": "application/json",
                    "x-bot-secret": DOP_WEBHOOK_SECRET,
                },
            )
            if response.status_code in (200, 201):
                logger.info(
                    f'[RESOLVE] Webhook delivered for '
                    f'{data.get("businessId")}'
                )
            else:
                logger.error(
                    f'[RESOLVE] Webhook failed '
                    f'{response.status_code}: '
                    f'{response.text[:200]}'
                )
    except Exception as e:
        logger.error(
            f'[RESOLVE] Webhook POST failed: '
            f'{type(e).__name__}: {e}'
        )


async def send_progress(
    business_id: str,
    session_id: str,
    stage: str,
    action: str,
    current: int = 0,
    total: int = 0,
    detail: str = "",
    folder_name: str = "",
    folders_total: int = 0,
):
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(
                f"{DOP_API_URL}/api/v1/seeding/bot/progress",
                json={
                    "businessId": business_id,
                    "sessionId": session_id,
                    "stage": stage,
                    "action": action,
                    "current": current,
                    "total": total,
                    "detail": detail,
                    "folderName": folder_name,
                    "foldersTotal": folders_total,
                },
                headers={
                    "Content-Type": "application/json",
                    "x-bot-secret": DOP_WEBHOOK_SECRET,
                },
            )
    except Exception as e:
        logger.warning(f"Progress update failed: {e}")


async def make_progress_callback(business_id: str, session_id: str):
    async def callback(stage, action, current, total, detail,
                       folder_name: str = ""):
        await send_progress(
            business_id, session_id,
            stage, action, current, total, detail,
            folder_name=folder_name,
        )
    return callback


async def run_email_scrape_job(req: ScrapeRequest) -> None:
    """Visit the business's own website and extract a literally-present
    email. Never infers, never uses a third party. Posts the result
    back via the regular /bot/webhook — the API side inspects
    payload.emailScrape and routes to its email handler.

    Missing/empty `website` is a legitimate outcome, not an error. We
    complete the job successfully with skipped:'no_website' so the
    trigger endpoint can re-run only businesses that were re-resolved.
    """
    from email_scraper import run_email_scrape

    website = (req.website or "").strip()
    logger.info(
        f"[email_scrape] {req.businessId} website={website or '(none)'}"
    )

    if not website:
        payload = {
            "businessId": req.businessId,
            "environment": req.environment,
            "sessionId": req.sessionId,
            "scrapedAt": datetime.now(timezone.utc).isoformat(),
            "type": "email_scrape",
            "reviews": [],
            "gallery": [],
            "menu": [],
            "emailScrape": {
                "email": None,
                "confidence": None,
                "sourceUrl": None,
                "domainMatch": False,
                "alternates": [],
                "pagesVisited": 0,
                "skipped": "no_website",
            },
        }
        await post_webhook(payload)
        return

    try:
        result = await run_email_scrape(
            website=website,
            launch_browser=launch_browser,
        )
    except Exception as e:
        import traceback
        logger.error(
            f"[email_scrape] {req.businessId} failed: "
            f"{e}\n{traceback.format_exc()}"
        )
        raise

    logger.info(
        f"[email_scrape] {req.businessId} -> "
        f"email={result.get('email')!r} tier={result.get('confidence')} "
        f"pages={result.get('pagesVisited')} "
        f"skipped={result.get('skipped') or 'no'}"
    )

    payload = {
        "businessId": req.businessId,
        "environment": req.environment,
        "sessionId": req.sessionId,
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "type": "email_scrape",
        # Empty media arrays for shape compatibility — the API webhook
        # handler branches on emailScrape early and never inspects these.
        "reviews": [],
        "gallery": [],
        "menu": [],
        "emailScrape": result,
    }
    await post_webhook(payload)


async def post_webhook(data: dict):
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            response = await client.post(
                f"{DOP_API_URL}/api/v1/seeding/bot/webhook",
                json=data,
                headers={
                    "Content-Type": "application/json",
                    "x-bot-secret": DOP_WEBHOOK_SECRET,
                },
            )
            if response.status_code in (200, 201):
                logger.info(
                    f'Webhook delivered successfully '
                    f'for {data.get("placeId")}'
                )
            else:
                logger.error(
                    f'Webhook failed {response.status_code}: '
                    f'{response.text[:200]}'
                )
    except Exception as e:
        logger.error(
            f'Webhook POST failed for {data.get("placeId")}: '
            f'{type(e).__name__}: {e}'
        )


# ─── DISCOVERY_SEARCH handler ─────────────────────────────────────
#
# Given an Overture candidate (name, address, coords) and the region
# bbox, search Google Maps for the matching business and return
# {placeId, name, formattedAddress, lat, lng} or null with an error
# reason. Purpose-built for the discovery pipeline — no hours,
# no rating/cover/category, no state cross-validation (discovery
# candidates carry no stored state). Bbox reject IS the geo-side
# confident-match gate: a resolved place outside the region rectangle
# is a cross-region miss, not a real match.
#
# Reuses the primitives already proven in _resolve_in_context:
#   - _sanitize_query_fields  (query hygiene)
#   - _names_loose_match      (drill-in scoring; >=50 threshold, same
#                              as resolve_business)
#   - viewport-anchored /maps/search URL (@lat,lng,14z)
#   - h1 hydration wait + drill-in via "At this place" / results list
#   - ChIJ scan across initstate / url / script / content / dom
# Intentionally does NOT modify _resolve_in_context or any other
# existing handler.

_MAPS_URL_LATLNG_RE = _re.compile(
    r'/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,\d+(?:\.\d+)?z)?'
)
# Google embeds the place's own coords as !3d<lat>!4d<lng> inside
# the data= param. Present even when the /@lat,lng URL segment is
# missing (which happens on /maps/place/<Name>/data=... links). Use
# THIS in preference to @lat,lng where both exist — @lat,lng is the
# viewport centre, not the place, and can drift on drill-in.
_MAPS_URL_DATA_LATLNG_RE = _re.compile(
    r'!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)'
)


def _extract_latlng_from_url(url: str):
    """Parse the place's lat/lng out of a Google Maps URL. Prefers
    !3d/!4d (the place's own coords) over @lat,lng (viewport centre).
    Returns (lat, lng) as floats or (None, None) if not present /
    unparseable.
    """
    if not url:
        return (None, None)
    m = _MAPS_URL_DATA_LATLNG_RE.search(url)
    if not m:
        m = _MAPS_URL_LATLNG_RE.search(url)
    if not m:
        return (None, None)
    try:
        return (float(m.group(1)), float(m.group(2)))
    except (TypeError, ValueError):
        return (None, None)


async def _discovery_search_in_context(context, job: dict) -> dict:
    """Run one DISCOVERY_SEARCH job on the given BrowserContext.

    Returns a dict shaped to POST straight to /discovery/bot-result:
        { 'result': {placeId, name, formattedAddress, lat, lng} | None,
          'error': str | '' }
    """
    import re
    from urllib.parse import quote_plus

    business_name = (job.get('businessName') or '').strip()
    address_line1 = job.get('addressLine1') or ''
    lat_in = job.get('latitude')
    lng_in = job.get('longitude')
    bbox_w = job.get('discoveryBboxWest')
    bbox_s = job.get('discoveryBboxSouth')
    bbox_e = job.get('discoveryBboxEast')
    bbox_n = job.get('discoveryBboxNorth')
    src_id = job.get('discoveryOvertureSourceId') or '(none)'

    # Log id: source id + trimmed name so a batch summary can grep back
    # to the exact candidate in Overture.
    tag = f'{src_id[:12]}/{business_name[:40]}'

    # Same sanitizer path as resolve_business. Discovery jobs carry
    # empty city/state (the API strips them since Overture doesn't
    # provide them on candidates), so most fields drop out — the
    # sanitizer still guards addressLine1 against phone/URL junk.
    sq = _sanitize_query_fields(
        address_line1, '',                    # addressLine1 + legacy address1
        job.get('city') or '', job.get('state') or '',
        lat_in, lng_in,
    )
    sanitized_addr = sq['addressLine1']

    # Viewport anchor. Prefer the candidate's own coords when present
    # (a tighter anchor than the region centroid), else fall back to
    # the bbox centroid so we still bias ranking into the region.
    has_geo_anchor = False
    anchor_lat = None
    anchor_lng = None
    if (
        isinstance(lat_in, (int, float))
        and isinstance(lng_in, (int, float))
        and -90 <= float(lat_in) <= 90
        and -180 <= float(lng_in) <= 180
        and not (float(lat_in) == 0.0 and float(lng_in) == 0.0)
    ):
        anchor_lat = float(lat_in)
        anchor_lng = float(lng_in)
        has_geo_anchor = True
    elif (
        isinstance(bbox_w, (int, float))
        and isinstance(bbox_s, (int, float))
        and isinstance(bbox_e, (int, float))
        and isinstance(bbox_n, (int, float))
    ):
        anchor_lat = (float(bbox_s) + float(bbox_n)) / 2.0
        anchor_lng = (float(bbox_w) + float(bbox_e)) / 2.0
        has_geo_anchor = True
    geo_anchor_suffix = (
        f'/@{anchor_lat},{anchor_lng},14z' if has_geo_anchor else ''
    )

    if not business_name:
        return {'result': None, 'error': 'no_business_name'}

    query_parts = [business_name, sanitized_addr]
    query = ' '.join([p for p in query_parts if p])
    target_url = (
        f'https://www.google.com/maps/search/{quote_plus(query)}'
        f'{geo_anchor_suffix}'
    )

    logger.info(
        f'[DISCOVERY-SEARCH] {tag} '
        f'geo_anchor={"present" if has_geo_anchor else "missing"} '
        f'→ {target_url[:160]}'
    )

    resolved_name = None
    resolved_place_id = None
    resolved_lat = None
    resolved_lng = None
    resolved_formatted = None
    error_msg = ''

    page = await context.new_page()
    try:
        await page.goto(
            target_url,
            wait_until='domcontentloaded',
            timeout=40000,
        )

        for sel in [
            'button[aria-label*="Accept all"]',
            'button[aria-label*="Accept"]',
            'button[aria-label*="Agree"]',
        ]:
            try:
                btn = page.locator(sel).first
                if await btn.is_visible(timeout=1500):
                    await btn.click()
                    await page.wait_for_timeout(600)
                    break
            except Exception:
                pass

        # Wait for either a single business panel (h1) or a results
        # feed. If Google lands us on a results list, we drill into
        # the best-name-match entry.
        h1_present = False
        try:
            await page.wait_for_selector(
                'h1.DUwDvf, h1.fontHeadlineLarge',
                timeout=15000,
            )
            h1_present = True
            await page.wait_for_timeout(1200)
        except Exception:
            pass

        # If we DIDN'T land directly on a business, try the results
        # list. Same selectors + same _names_loose_match scoring as
        # the resolve_business drill-in above.
        candidates: list = []
        if h1_present:
            try:
                resolved_name = (
                    await page.locator(
                        'h1.DUwDvf, h1.fontHeadlineLarge'
                    ).first.inner_text(timeout=5000)
                ).strip()
            except Exception:
                resolved_name = None

        # Address-title detection: search landed on the building panel
        # (h1 == the address we searched) instead of a business.
        addr_for_compare = sanitized_addr.strip().lower()
        name_looks_like_address = bool(
            resolved_name
            and addr_for_compare
            and (
                resolved_name.lower() in addr_for_compare
                or addr_for_compare in resolved_name.lower()
            )
        )

        need_drill_in = (not resolved_name) or name_looks_like_address

        if need_drill_in:
            try:
                candidates = await page.evaluate(r"""() => {
                    const out = [];
                    const seen = new Set();
                    const selectors = [
                        'a.hfpxzc[aria-label]',
                        'a[href*="/maps/place/"][aria-label]',
                        'div[role="feed"] a[href*="/maps/place/"]',
                        'div[role="article"] a[href*="/maps/place/"]',
                        'a[jsaction][href*="/maps/place/"]',
                    ];
                    for (const sel of selectors) {
                        const els = document.querySelectorAll(sel);
                        for (const el of els) {
                            const aria =
                                el.getAttribute('aria-label') || '';
                            const inner = (
                                el.innerText || el.textContent || ''
                            ).trim();
                            const raw = aria || inner.split('\n')[0];
                            const name = (raw || '').trim();
                            if (!name || name.length < 2) continue;
                            const href = el.href || '';
                            if (
                                !href ||
                                !href.includes('/maps/place/')
                            ) continue;
                            const key = name + '|' + href;
                            if (seen.has(key)) continue;
                            seen.add(key);
                            out.push({ name, href });
                        }
                        if (out.length > 0) break;
                    }
                    return out;
                }""") or []
            except Exception:
                candidates = []

            best_entry = None
            best_score = 0
            best_rule = 'no_match'
            for c in candidates:
                name = (c.get('name') or '').strip()
                if not name:
                    continue
                # Same scoring the resolve drill-in uses. City=None
                # because discovery jobs don't carry a stored city.
                m = _names_loose_match(business_name, name, city=None)
                if m['match']:
                    score = {
                        'equal': 100, 'contains': 90,
                        'equal_suffixed': 80,
                        'overlap': 60, 'jaccard': 60,
                    }.get(m['rule'], 50)
                else:
                    # Legacy fallback (same as resolve): raw
                    # max-set token overlap so we don't newly
                    # reject anything the old code would take.
                    tgt_norm = re.sub(
                        r'[^\w\s]', '', business_name.lower(),
                    ).strip()
                    tgt_toks = (
                        set(tgt_norm.split()) if tgt_norm else set()
                    )
                    name_norm = re.sub(
                        r'[^\w\s]', '', name.lower(),
                    ).strip()
                    name_toks = (
                        set(name_norm.split()) if name_norm else set()
                    )
                    score = 0
                    if tgt_toks and name_toks:
                        overlap = len(name_toks & tgt_toks)
                        if overlap > 0:
                            denom = max(len(name_toks), len(tgt_toks))
                            score = int((overlap / denom) * 60)
                if score > best_score:
                    best_score = score
                    best_entry = c
                    best_rule = m['rule'] if m['match'] else 'legacy'

            if best_entry and best_score >= 50:
                href = best_entry.get('href', '')
                logger.info(
                    f'[DISCOVERY-SEARCH] {tag} drill-in: matched '
                    f'"{best_entry.get("name")}" '
                    f'(score={best_score} rule={best_rule}) '
                    f'→ {href[:100]}'
                )
                try:
                    await page.goto(
                        href,
                        wait_until='domcontentloaded',
                        timeout=40000,
                    )
                    for sel in [
                        'button[aria-label*="Accept all"]',
                        'button[aria-label*="Accept"]',
                        'button[aria-label*="Agree"]',
                    ]:
                        try:
                            btn = page.locator(sel).first
                            if await btn.is_visible(timeout=1000):
                                await btn.click()
                                await page.wait_for_timeout(400)
                                break
                        except Exception:
                            pass
                    try:
                        await page.wait_for_selector(
                            'h1.DUwDvf, h1.fontHeadlineLarge',
                            timeout=15000,
                        )
                        await page.wait_for_timeout(1200)
                        h1_present = True
                        try:
                            resolved_name = (
                                await page.locator(
                                    'h1.DUwDvf, h1.fontHeadlineLarge'
                                ).first.inner_text(timeout=5000)
                            ).strip()
                        except Exception:
                            pass
                    except Exception:
                        pass
                except Exception as e:
                    logger.warning(
                        f'[DISCOVERY-SEARCH] {tag} drill-in nav '
                        f'failed: {e}'
                    )
            else:
                error_msg = 'no_confident_match'
                logger.info(
                    f'[DISCOVERY-SEARCH] {tag} no confident match '
                    f'(entries={len(candidates)} '
                    f'best_score={best_score})'
                )

        # ── placeId (ChIJ) — reuse the multi-source scan pattern ──
        if h1_present:
            try:
                chij_dump = await page.evaluate(r"""() => {
                    const CHIJ = /ChIJ[A-Za-z0-9_-]{20,}/g;
                    const collect = (s) => {
                        if (!s) return [];
                        const m = String(s).match(CHIJ);
                        return m ? Array.from(m) : [];
                    };
                    const out = {
                        initstate: [], url: [],
                        script: [], content: [], dom: [],
                    };
                    try {
                        const init = window.APP_INITIALIZATION_STATE;
                        if (init) out.initstate = collect(
                            JSON.stringify(init),
                        );
                    } catch (e) {}
                    try { out.url = collect(location.href); }
                    catch (e) {}
                    try {
                        for (const sc of document.querySelectorAll(
                            'script',
                        )) {
                            for (const v of collect(sc.textContent)) {
                                out.script.push(v);
                            }
                        }
                    } catch (e) {}
                    try {
                        out.content = collect(
                            document.documentElement.outerHTML,
                        );
                    } catch (e) {}
                    try {
                        const main = document.querySelector(
                            'div[role="main"], div.bJzME',
                        );
                        if (main) {
                            for (const attr of [
                                'data-pid', 'data-place-id',
                            ]) {
                                const el = main.querySelector(
                                    `[${attr}]`,
                                );
                                if (el) for (const v of collect(
                                    el.getAttribute(attr),
                                )) out.dom.push(v);
                            }
                        }
                        for (const a of document.querySelectorAll(
                            'a[href*="/maps/place/"]',
                        )) {
                            for (const v of collect(a.href)) {
                                out.dom.push(v);
                            }
                        }
                    } catch (e) {}
                    return out;
                }""")
                if isinstance(chij_dump, dict):
                    for src in (
                        'initstate', 'url', 'script', 'content', 'dom',
                    ):
                        for cand in chij_dump.get(src, []) or []:
                            if cand:
                                resolved_place_id = cand
                                break
                        if resolved_place_id:
                            break
            except Exception:
                pass

        # ── lat/lng of the RESOLVED PLACE (not the anchor) ──
        # Ordering is important — we've been burned once already:
        #   1) meta[itemprop=latitude|longitude]  — the place's own
        #      coords, embedded by Google in the panel head. Most
        #      trustworthy source when present.
        #   2) !3d<lat>!4d<lng> in the URL — the place's coords
        #      embedded in the data= param. Present on /maps/place/
        #      URLs (i.e. after a drill-in or when Google rewrote
        #      the URL post-hydration). Trustworthy.
        #   3) @lat,lng in a /maps/place/ URL — viewport centre,
        #      usually close to the place. Acceptable fallback.
        #   4) @lat,lng in a /maps/search/ URL — the ANCHOR we sent
        #      in the request, NOT the place. Explicitly rejected:
        #      returning it would zero-out the input-vs-resolved
        #      distance signal downstream and let cross-street /
        #      cross-city misses slip through.
        # A naive initstate [num,num] scan was tried once and rejected
        # — it matched viewport corners and bounds rects, producing
        # NaN coords that later tripped bbox_reject with a misleading
        # (nan,nan) log line.
        if h1_present:
            try:
                cur_url = page.url or ''
            except Exception:
                cur_url = ''

            # 1) !3d<lat>!4d<lng> in the current URL — the place's own
            # coords embedded in the data= param. Present on
            # /maps/place/ URLs (drilled-in cases).
            data_m = _MAPS_URL_DATA_LATLNG_RE.search(cur_url)
            if data_m:
                try:
                    resolved_lat = float(data_m.group(1))
                    resolved_lng = float(data_m.group(2))
                except (TypeError, ValueError):
                    pass

            # 2) DOM anchor scan for the place's own /maps/place/...
            # link (contains !3d/!4d). Google renders a directions
            # button + a share link + a hero-image link, all pointing
            # at the current place — so a same-page anchor with real
            # coords is almost always available even on /maps/search/
            # URLs where the location bar stays at @anchor.
            if resolved_lat is None or resolved_lng is None:
                try:
                    href_coords = await page.evaluate(r"""() => {
                        // Same-page anchors that carry the current
                        // place's !3d/!4d. Restrict to /maps/place/
                        // links so we don't grab a related-place
                        // link elsewhere in the page.
                        const anchors = document.querySelectorAll(
                            'a[href*="/maps/place/"][href*="!3d"]'
                            + '[href*="!4d"]',
                        );
                        const re = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/;
                        for (const a of anchors) {
                            const m = (a.href || '').match(re);
                            if (m) {
                                return [
                                    parseFloat(m[1]),
                                    parseFloat(m[2]),
                                ];
                            }
                        }
                        return null;
                    }""")
                    if (
                        isinstance(href_coords, list)
                        and len(href_coords) == 2
                        and _re.match(
                            r'^-?\d', str(href_coords[0])
                        )
                    ):
                        resolved_lat = float(href_coords[0])
                        resolved_lng = float(href_coords[1])
                except Exception:
                    pass

            # 3) Fallback: @lat,lng from the current URL. On
            # /maps/place/ URLs this is the viewport centre (usually
            # ≈ the place). On /maps/search/ URLs — the case Google
            # never rewrites for direct-hit resolutions — it's the
            # anchor we sent. That means input-vs-resolved distance
            # ≈ 0 for those, which loses the geo-side sanity signal
            # but doesn't break correctness: name similarity is
            # still enforced downstream (nameSimilarity in
            # discovery-run.service.ts) and catches cross-place
            # misses. Not returning coords at all was worse — the
            # entire cohort of direct-search resolutions gets
            # rejected as no_coords_extracted despite having a
            # perfectly valid resolved placeId + name. Bbox reject
            # still functions on drill-in cases where !3d/!4d gives
            # us the true place coords.
            if resolved_lat is None or resolved_lng is None:
                at_m = _MAPS_URL_LATLNG_RE.search(cur_url)
                if at_m:
                    try:
                        resolved_lat = float(at_m.group(1))
                        resolved_lng = float(at_m.group(2))
                    except (TypeError, ValueError):
                        pass

        # ── formatted address ──
        try:
            addr_txt = await page.locator(
                'button[data-item-id="address"] div.fontBodyMedium',
            ).first.inner_text(timeout=800)
            if addr_txt and addr_txt.strip():
                resolved_formatted = re.sub(
                    r'\s+', ' ', addr_txt,
                ).strip()
        except Exception:
            pass
        if not resolved_formatted:
            try:
                aria = await page.locator(
                    'button[data-item-id="address"]',
                ).first.get_attribute('aria-label', timeout=800)
                if aria:
                    cleaned = re.sub(
                        r'^\s*address[:,\s]+',
                        '',
                        aria,
                        flags=re.IGNORECASE,
                    )
                    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
                    if cleaned:
                        resolved_formatted = cleaned
            except Exception:
                pass

    except Exception as e:
        import traceback
        error_msg = f'{type(e).__name__}: {e}'
        logger.error(
            f'[DISCOVERY-SEARCH] {tag} failed: '
            f'{e}\n{traceback.format_exc()}'
        )
    finally:
        try:
            await page.close()
        except Exception:
            pass

    # ── Post-nav confident-match gates ──
    # If we haven't already set an error and something's missing to
    # ship a valid result, downgrade to null with the reason. NaN
    # counts as missing — a stray NaN slipping into a valid-looking
    # payload would fail the bbox check with misleading (nan,nan)
    # log lines and pollute downstream.
    def _finite(x) -> bool:
        try:
            return isinstance(x, (int, float)) and x == x  # NaN != NaN
        except Exception:
            return False

    if not error_msg:
        if not resolved_place_id:
            error_msg = 'no_place_id_extracted'
        elif not (_finite(resolved_lat) and _finite(resolved_lng)):
            error_msg = 'no_coords_extracted'

    # Bbox reject (schema comment: "hard reject: if the resolved place
    # lands outside this rectangle we return null rather than accept
    # a cross-region match"). Only enforceable when we have both
    # coords and a valid bbox.
    if (
        not error_msg
        and resolved_lat is not None
        and resolved_lng is not None
        and isinstance(bbox_w, (int, float))
        and isinstance(bbox_s, (int, float))
        and isinstance(bbox_e, (int, float))
        and isinstance(bbox_n, (int, float))
    ):
        if not (
            float(bbox_w) <= float(resolved_lng) <= float(bbox_e)
            and float(bbox_s) <= float(resolved_lat) <= float(bbox_n)
        ):
            logger.warning(
                f'[DISCOVERY-SEARCH] {tag} bbox_reject: resolved '
                f'({resolved_lat:.5f},{resolved_lng:.5f}) outside '
                f'[W {bbox_w}, S {bbox_s}, E {bbox_e}, N {bbox_n}]'
            )
            error_msg = 'bbox_reject'

    if error_msg:
        return {'result': None, 'error': error_msg}

    logger.info(
        f'[DISCOVERY-SEARCH] {tag} ✓ placeId={resolved_place_id} '
        f'name={resolved_name!r} '
        f'coords=({resolved_lat:.5f},{resolved_lng:.5f}) '
        f'addr={(resolved_formatted or "")[:60]!r}'
    )
    return {
        'result': {
            'placeId': resolved_place_id,
            'name': resolved_name or '',
            'formattedAddress': resolved_formatted or '',
            'lat': resolved_lat,
            'lng': resolved_lng,
        },
        'error': '',
    }


async def _poll_discovery_batch(limit: int) -> list:
    """Atomically claim up to `limit` discovery_search jobs. Same
    /bot/poll-batch endpoint the resolve pool uses — the server-side
    excludes discovery from the single-job /bot/poll, so pool is the
    only intake path.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f'{DOP_API_URL}/api/v1/seeding/bot/poll-batch',
                params={'type': 'discovery_search', 'limit': limit},
                headers={'x-bot-secret': DOP_WEBHOOK_SECRET},
            )
    except Exception as e:
        logger.warning(f'[DISCOVERY-POOL] poll-batch request failed: {e}')
        return []
    if r.status_code != 200:
        logger.warning(
            f'[DISCOVERY-POOL] poll-batch HTTP {r.status_code}: '
            f'{r.text[:160]}'
        )
        return []
    try:
        data = r.json()
    except Exception:
        return []
    return data.get('jobs') or []


async def _post_discovery_result(job_id: str, payload: dict) -> bool:
    """POST the bot-result to /discovery/bot-result. Returns True on
    2xx. Note the endpoint atomically sets the job to DONE, so we do
    NOT need a separate /bot/job/:id/complete call — that would be a
    no-op that also risks re-triggering the session-bucket increment.
    """
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f'{DOP_API_URL}/api/v1/seeding/discovery/bot-result',
                json={'jobId': job_id, **payload},
                headers={
                    'Content-Type': 'application/json',
                    'x-bot-secret': DOP_WEBHOOK_SECRET,
                },
            )
            if r.status_code in (200, 201):
                return True
            logger.error(
                f'[DISCOVERY-POOL] bot-result HTTP {r.status_code}: '
                f'{r.text[:200]}'
            )
            return False
    except Exception as e:
        logger.error(
            f'[DISCOVERY-POOL] bot-result POST failed: '
            f'{type(e).__name__}: {e}'
        )
        return False


async def _discovery_worker(
    worker_id: int,
    queue: 'asyncio.Queue',
    browser,
    cookies,
    jitter_ms: int,
):
    """Persistent worker: pull (job, stats) off the queue, run the
    discovery search on a fresh context off the shared browser, post
    the bot-result, tally outcome, sleep jittered, repeat.

    A failure inside a single job does NOT propagate — the worker
    marks that job failed and moves on. If bot-result POST fails,
    the job stays in RUNNING until resetStuckJobs flips it back.
    """
    while True:
        job, stats = await queue.get()
        job_id = str(job.get('_id') or '')
        try:
            context = await _resolve_make_context(browser, cookies)
            try:
                payload = await _discovery_search_in_context(
                    context, job,
                )
            finally:
                try:
                    await context.close()
                except Exception:
                    pass

            posted = await _post_discovery_result(job_id, payload)
            if not posted:
                stats['failed'] += 1
            elif payload.get('result'):
                stats['resolved'] += 1
            else:
                # Bot successfully decided "no confident match" —
                # counts as a completed job, not a failure. The
                # discovery orchestrator maps it to zero_result.
                stats['no_match'] += 1
        except asyncio.CancelledError:
            raise
        except Exception as e:
            stats['failed'] += 1
            logger.error(
                f'[DISCOVERY-POOL] worker {worker_id} '
                f'job {job_id} failed: {type(e).__name__}: {e}'
            )
            # Best-effort: tell the API this job failed so it doesn't
            # linger in RUNNING for 10min until resetStuckJobs
            # rescues it. Uses the shared /bot/job/:id/complete path
            # — the discovery bot-result endpoint would also mark
            # DONE but we didn't successfully compute a result.
            try:
                async with httpx.AsyncClient(timeout=10) as c:
                    await c.post(
                        f'{DOP_API_URL}/api/v1/seeding/bot/job/'
                        f'{job_id}/complete',
                        json={
                            'success': False,
                            'error': f'{type(e).__name__}: {e}',
                        },
                        headers={'x-bot-secret': DOP_WEBHOOK_SECRET},
                    )
            except Exception as ce:
                logger.warning(
                    f'[DISCOVERY-POOL] worker {worker_id} '
                    f'job/complete post failed: {ce}'
                )

        queue.task_done()

        if jitter_ms > 0:
            try:
                delay = random.uniform(
                    jitter_ms * 0.5, jitter_ms * 1.5,
                ) / 1000.0
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                raise


async def discovery_pool_loop():
    """Top-level pool loop for DISCOVERY_SEARCH jobs. Mirrors
    resolve_pool_loop: claim a batch, dispatch across workers, log a
    per-batch summary, repeat. Shared Chromium is launched lazily on
    the first non-empty batch.
    """
    logger.info(
        f'[DISCOVERY-POOL] Starting (workers={DISCOVERY_WORKERS} '
        f'jitter_ms={DISCOVERY_JITTER_MS})'
    )

    from playwright.async_api import async_playwright

    cookies = load_cookies()
    queue: asyncio.Queue = asyncio.Queue()
    worker_tasks: list = []
    pw = None
    browser = None

    try:
        pw = await async_playwright().start()
        while True:
            try:
                jobs = await _poll_discovery_batch(DISCOVERY_WORKERS)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f'[DISCOVERY-POOL] poll-batch failed: {e}')
                await asyncio.sleep(POLL_INTERVAL)
                continue

            if not jobs:
                await asyncio.sleep(POLL_INTERVAL)
                continue

            if browser is None:
                try:
                    browser = await launch_browser(
                        pw,
                        headless=HEADLESS,
                        args=[
                            '--no-sandbox',
                            '--disable-blink-features=AutomationControlled',
                            '--disable-dev-shm-usage',
                        ],
                    )
                    logger.info(
                        '[DISCOVERY-POOL] Shared Chromium launched',
                    )
                except Exception as e:
                    logger.error(
                        f'[DISCOVERY-POOL] Chromium launch failed: {e}'
                    )
                    await asyncio.sleep(POLL_INTERVAL)
                    continue

            if not worker_tasks:
                worker_tasks = [
                    asyncio.create_task(
                        _discovery_worker(
                            i, queue, browser, cookies,
                            DISCOVERY_JITTER_MS,
                        )
                    )
                    for i in range(DISCOVERY_WORKERS)
                ]

            batch_start = time.time()
            stats = {'resolved': 0, 'no_match': 0, 'failed': 0}
            claimed = len(jobs)
            logger.info(
                f'[DISCOVERY-POOL] Batch claimed: {claimed} job(s)'
            )

            for job in jobs:
                await queue.put((job, stats))

            await queue.join()

            elapsed = time.time() - batch_start
            logger.info(
                f'[DISCOVERY-POOL] Batch done — claimed={claimed} '
                f'resolved={stats["resolved"]} '
                f'no_match={stats["no_match"]} '
                f'failed={stats["failed"]} '
                f'elapsed={elapsed:.1f}s'
            )
    except asyncio.CancelledError:
        raise
    finally:
        for t in worker_tasks:
            t.cancel()
        for t in worker_tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass
        if pw is not None:
            try:
                await pw.stop()
            except Exception:
                pass
