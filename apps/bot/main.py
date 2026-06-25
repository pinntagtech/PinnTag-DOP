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
    logger.info(f"Chrome path: {CHROME_PATH or 'bundled Chromium'}")
    logger.info(f'Log level: {LOG_LEVEL}')

    # Self-update runs BEFORE we kick off the poll loops. If it finds a
    # newer version it overwrites the .py files and os.execv's into the
    # new process — nothing below this line gets reached on that path.
    await self_update_if_newer()

    logger.info(
        f'Resolve pool: workers={RESOLVE_WORKERS} '
        f'jitter_ms={RESOLVE_JITTER_MS}'
    )

    # Start background polling loops:
    #  - polling_loop:    serial path for gallery_menu / reviews / image_sync
    #                     / cover_sync (claims via /bot/poll, resolve excluded
    #                     server-side so the pool below owns it).
    #  - resolve_pool_loop: parallel worker pool for resolve_business jobs
    #                     using a shared Chromium + per-job context.
    poll_task = asyncio.create_task(polling_loop())
    resolve_pool_task = asyncio.create_task(resolve_pool_loop())

    yield

    logger.info('PinnTag Bot Service shutting down')
    for t in (poll_task, resolve_pool_task):
        t.cancel()
    for t in (poll_task, resolve_pool_task):
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


# System Chrome executable path. Required on Ubuntu 26.04 where Playwright's
# bundled Chromium won't install — point at the OS Google Chrome instead.
# Empty / unset → Playwright uses its own bundled Chromium (Mac, older Ubuntu).
def _resolve_chrome_path() -> str | None:
    # 1. Explicit override always wins
    env = os.getenv("CHROME_PATH", "").strip()
    if env:
        return env
    # 2. Common system Chrome locations
    candidates = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None  # fall back to Playwright bundled Chromium


CHROME_PATH = _resolve_chrome_path()

SKIP_FOLDERS = {
    'all',
    'latest',
}


POLL_INTERVAL = 5  # seconds between polls

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
            city=job.get('city', '') or '',
            state=job.get('state', '') or '',
            postalCode=job.get('postalCode', '') or '',
        )

        try:
            if job_type == 'image_sync':
                await run_image_sync(req)
            elif job_type == 'cover_sync':
                await run_cover_sync(req)
            elif job_type == 'resolve_business':
                await run_resolve_business(req)
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
    city: Optional[str] = ""
    state: Optional[str] = ""
    postalCode: Optional[str] = ""


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
                # GALLERY_USE_BUNDLED=1 forces Playwright's bundled Chromium for the
                # gallery/menu launch (system Chrome was rendering Maps place pages
                # empty on some machines). Defaults to the normal CHROME_PATH behavior.
                _gallery_exec = None if os.getenv("GALLERY_USE_BUNDLED") == "1" \
                    else (CHROME_PATH if CHROME_PATH else None)
                browser = await p.chromium.launch(
                    executable_path=_gallery_exec,
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

                # Wait for the place panel to hydrate (proven resolve-path signal).
                h1_present = False
                try:
                    await page.wait_for_selector(
                        'h1.DUwDvf, h1.fontHeadlineLarge',
                        timeout=15000,
                    )
                    h1_present = True
                    await page.wait_for_timeout(1500)  # let transient title settle
                except Exception:
                    logger.warning(
                        f"[GALLERY] place panel h1 never appeared — url={page.url[:140]}"
                    )
                # Street-View guard: if the redirect bounced into a panorama, log it.
                sv = ("/@" in page.url and (",3a," in page.url
                      or "!1e1" in page.url or "!1e2" in page.url))
                if sv:
                    logger.warning(f"[GALLERY] landed in Street View — url={page.url[:140]}")

                # Exit Street View if the place deep-linked into the pano.
                # On Street View there's no hero image, so the photo-open
                # below would miss. Get back to the place card first.
                for attempt in range(4):
                    sv = ("/@" in page.url and (",3a," in page.url
                          or "!1e1" in page.url or "!1e2" in page.url))
                    if not sv:
                        break
                    logger.info(f"[GALLERY] in Street View (attempt {attempt+1}) — exiting")
                    closed = False
                    # 1) the Street View overlay close (X) button
                    for sel in [
                        'button[aria-label="Close"]',
                        'button[jsaction*="settings.close"]',
                        'button[aria-label*="Back to"]',
                        'button[aria-label*="Exit"]',
                    ]:
                        try:
                            b = page.locator(sel).first
                            if await b.is_visible(timeout=800):
                                await b.click(timeout=1500)
                                await page.wait_for_timeout(1200)
                                closed = True
                                break
                        except Exception:
                            continue
                    # 2) fallback: browser back
                    if not closed:
                        try:
                            await page.go_back(wait_until="domcontentloaded", timeout=8000)
                            await page.wait_for_timeout(1200)
                        except Exception:
                            pass
                    # 3) last resort: re-navigate to the place URL fresh
                    sv = ("/@" in page.url and (",3a," in page.url
                          or "!1e1" in page.url or "!1e2" in page.url))
                    if sv and attempt >= 2:
                        try:
                            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                            await page.wait_for_timeout(2500)
                        except Exception:
                            pass
                logger.info(f"[GALLERY] post-streetview url={page.url[:110]}")
                # Re-wait for the place h1 after exiting Street View.
                try:
                    await page.wait_for_selector(
                        'h1.DUwDvf, h1.fontHeadlineLarge', timeout=8000)
                    await page.wait_for_timeout(1000)
                except Exception:
                    pass

                # Open the gallery via the "All" card in the "Photos & videos"
                # section of the place panel — the designed gallery entry (NOT
                # the hero/cover image, which opens a single photo or Street View).
                photo_opened = False
                # Scroll the place panel so the Photos & videos section is in view.
                try:
                    await page.evaluate("""() => {
                        const hdr = [...document.querySelectorAll('h2,h3,div')]
                            .find(e => /photos?\\s*&?\\s*videos?/i.test(e.textContent||''));
                        if (hdr) hdr.scrollIntoView({block:'center'});
                    }""")
                    await page.wait_for_timeout(800)
                except Exception:
                    pass

                all_card_selectors = [
                    'button[aria-label^="All"]',
                    'button[aria-label="All"]',
                    'button[aria-label*="All photos"]',
                    'button[jsaction*="pane.heroHeaderImage.click"]',  # fallback
                    'button[aria-label*="Photo"]',
                ]
                # Prefer an exact "All" card: find a button whose visible text is "All".
                try:
                    clicked = await page.evaluate("""() => {
                        const btns = [...document.querySelectorAll('button,a')];
                        // exact "All" label/text first
                        let el = btns.find(b => {
                            const t=(b.getAttribute('aria-label')||b.innerText||'').trim();
                            return t === 'All' || /^All\\b/.test(t);
                        });
                        if (el){ el.click(); return true; }
                        return false;
                    }""")
                    if clicked:
                        await page.wait_for_timeout(2000)
                except Exception:
                    clicked = False

                # Verify or fall back to selector clicks.
                async def _grid_open():
                    c = await page.evaluate("""() => ({
                        tabs: document.querySelectorAll('[role="tab"]').length,
                        tiles: document.querySelectorAll('[style*="background-image"]').length,
                        imgs: document.querySelectorAll('img[src*="googleusercontent"]').length,
                    })""")
                    return c["tabs"] > 0 or c["tiles"] > 5 or c["imgs"] > 5, c

                ok, counts = await _grid_open()
                if ok:
                    photo_opened = True
                    logger.info(f"[GALLERY] opened via 'All' card text (tabs={counts['tabs']} tiles={counts['tiles']} imgs={counts['imgs']})")
                else:
                    for sel in all_card_selectors:
                        try:
                            el = page.locator(sel).first
                            if await el.is_visible(timeout=1000):
                                await el.click(timeout=2000)
                                await page.wait_for_timeout(2000)
                                ok, counts = await _grid_open()
                                if ok:
                                    photo_opened = True
                                    logger.info(f"[GALLERY] opened via '{sel}' (tabs={counts['tabs']} tiles={counts['tiles']} imgs={counts['imgs']})")
                                    break
                        except Exception:
                            continue
                if not photo_opened:
                    logger.warning("[GALLERY] could not open photo grid via All card")

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
                                already_open=photo_opened,
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
            browser = await p.chromium.launch(
                executable_path=CHROME_PATH if CHROME_PATH else None,
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
        browser = await p.chromium.launch(
            executable_path=CHROME_PATH if CHROME_PATH else None,
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
            browser = await p.chromium.launch(
                executable_path=CHROME_PATH if CHROME_PATH else None,
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

    place_id_in = (req.placeId or '').strip()
    use_place_id = bool(re.match(r'^ChIJ[A-Za-z0-9_-]+$', place_id_in))
    has_name = bool((req.businessName or '').strip())

    # PRIMARY: when we have a business name, search by name+address. The
    # placeIds we have on file are ADDRESS/BUILDING ids, not business
    # ids — navigating ?q=place_id:<id> opens the building's panel and
    # the "At this place" tenant DOM has been unreliable to scrape.
    # A name+address search lands on the business POI directly (or on a
    # short results list that we then click into below).
    #
    # nav_path tracks which URL strategy we used so the placeId echo /
    # sanity guards downstream can act accordingly.
    nav_path = 'search'
    if has_name:
        query_parts = [
            (req.businessName or '').strip(),
            (req.addressLine1 or '').strip(),
            (req.city or '').strip(),
            (req.state or '').strip(),
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
        )
    elif use_place_id:
        nav_path = 'place_id'
        target_url = (
            f'https://www.google.com/maps/place/'
            f'?q=place_id:{place_id_in}'
        )
    else:
        parts = [
            (req.addressLine1 or '').strip(),
            (req.city or '').strip(),
            (req.state or '').strip(),
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
        )

    logger.info(
        f'[RESOLVE] {req.businessId} → {target_url[:120]}'
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
            (req.addressLine1 or '').strip(),
            (req.city or '').strip(),
            (req.state or '').strip(),
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
            for c in candidates:
                name = (c.get('name') or '').strip()
                name_norm = re.sub(
                    r'[^\w\s]', '', name.lower(),
                ).strip()
                if not name_norm:
                    continue
                name_tokens = set(name_norm.split())

                score = 0
                if name_norm == target_name_norm:
                    score = 100
                elif (
                    name_norm in target_name_norm
                    or target_name_norm in name_norm
                ):
                    score = 70
                elif target_tokens:
                    overlap = len(name_tokens & target_tokens)
                    if overlap > 0:
                        denom = max(
                            len(name_tokens), len(target_tokens),
                        )
                        score = int((overlap / denom) * 60)

                if score > atplace_best_score:
                    atplace_best_score = score
                    best_entry = c

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

        # Google formatted address — full single-line raw string from
        # the address button. Same SEL pattern scraper_bulk uses; we
        # ship the raw text to the API and let libpostal parse it
        # there (US/India formats diverge structurally — never split
        # client-side). Cheap read; failure here never blocks
        # hours/rating/cover/category.
        try:
            addr_txt = await page.locator(
                'button[data-item-id="address"] div.fontBodyMedium',
            ).first.inner_text(timeout=800)
            if addr_txt and addr_txt.strip():
                google_formatted_address = re.sub(
                    r'\s+', ' ', addr_txt,
                ).strip()
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
            f'{"yes" if google_formatted_address else "no"}'
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

    return {
        'resolvedName': resolved_name,
        'resolvedPlaceId': resolved_place_id,
        'hoursRaw': hours_raw,
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
        browser = await p.chromium.launch(
            executable_path=CHROME_PATH if CHROME_PATH else None,
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
                city=job.get('city', '') or '',
                state=job.get('state', '') or '',
                postalCode=job.get('postalCode', '') or '',
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
                    browser = await pw.chromium.launch(
                        executable_path=CHROME_PATH if CHROME_PATH else None,
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
