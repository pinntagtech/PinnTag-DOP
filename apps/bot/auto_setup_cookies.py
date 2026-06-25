import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

GOOGLE_COOKIES_PATH = os.getenv('GOOGLE_COOKIES_PATH', './google_cookies.json')
COOKIE_MAX_AGE_DAYS = 25
PROFILE_DIR = os.getenv(
    'CHROME_PROFILE_DIR',
    str(Path.home() / '.pinntag-dop-bot-chrome-profile'),
)
AUTH_COOKIES = {'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
                '__Secure-1PSID', '__Secure-3PSID'}


def cookies_are_valid() -> bool:
    path = Path(GOOGLE_COOKIES_PATH)
    if not path.exists():
        return False
    age_days = (datetime.now().timestamp() - path.stat().st_mtime) / 86400
    if age_days > COOKIE_MAX_AGE_DAYS:
        print(f"[SETUP] Cookies are {age_days:.0f} days old — refreshing")
        return False
    try:
        cookies = json.loads(path.read_text())
        if not isinstance(cookies, list) or len(cookies) < 5:
            return False
        names = {c.get('name') for c in cookies}
        if not AUTH_COOKIES.intersection(names):
            print("[SETUP] Cookies missing Google auth tokens — refreshing")
            return False
        return True
    except Exception:
        return False


def _sanitize(raw: list) -> list:
    same_map = {'no_restriction': 'None', 'unspecified': 'Lax',
                'strict': 'Strict', 'lax': 'Lax', 'none': 'None'}
    out = []
    for c in raw:
        name = c.get('name', '')
        value = c.get('value', '')
        if not name or value is None:
            continue
        ck = {
            'name': name,
            'value': value,
            'domain': c.get('domain', '.google.com'),
            'path': c.get('path', '/'),
        }
        if c.get('secure') is not None:
            ck['secure'] = bool(c['secure'])
        if c.get('httpOnly') is not None:
            ck['httpOnly'] = bool(c['httpOnly'])
        ss = c.get('sameSite')
        if isinstance(ss, str):
            norm = same_map.get(ss.strip().lower(), ss if ss in
                                ('Strict', 'Lax', 'None') else None)
            if norm in ('Strict', 'Lax', 'None'):
                ck['sameSite'] = norm
        exp = c.get('expires') or c.get('expirationDate')
        if isinstance(exp, (int, float)) and exp > 0:
            ck['expires'] = int(exp)
        out.append(ck)
    return out


async def run_manual_capture() -> bool:
    from playwright.async_api import async_playwright

    channel = os.getenv("BOT_BROWSER_CHANNEL", "").strip()
    print("=" * 64)
    print("  PinnTag DOP — Google cookie capture (MANUAL)")
    print("=" * 64)
    print(f"  Browser: {channel or 'bundled Chromium'}")
    print(f"  Profile: {PROFILE_DIR}")
    print(f"  Output:  {GOOGLE_COOKIES_PATH}")
    print("-" * 64)

    Path(PROFILE_DIR).mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        launch_kwargs = dict(
            headless=False,
            args=[
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--no-default-browser-check',
                '--window-size=1100,800',
            ],
            viewport={'width': 1100, 'height': 800},
            locale='en-US',
        )
        if channel:
            launch_kwargs["channel"] = channel
        context = await p.chromium.launch_persistent_context(
            PROFILE_DIR, **launch_kwargs)
        page = context.pages[0] if context.pages else await context.new_page()
        try:
            await page.goto('https://accounts.google.com',
                            wait_until='domcontentloaded', timeout=40000)
        except Exception:
            pass

        print()
        print("  ┌────────────────────────────────────────────────────────┐")
        print("  │  1. In the Chrome window: sign in to your Google account│")
        print("  │     (handle any 2FA / 'verify it's you' prompts).      │")
        print("  │  2. Then open  https://www.google.com/maps  in that    │")
        print("  │     SAME window and wait for it to fully load.         │")
        print("  │  3. Come back here and press ENTER to capture cookies. │")
        print("  └────────────────────────────────────────────────────────┘")
        print()

        # BLOCK on human — no auto-detection. input() is sync; run in executor
        # so we don't block the event loop hard (browser stays responsive).
        await asyncio.get_event_loop().run_in_executor(
            None, input, "  >>> Press ENTER once logged in + Maps loaded... ")

        raw = await context.cookies()  # ALL domains, no scoping
        cookies = _sanitize(raw)
        Path(GOOGLE_COOKIES_PATH).write_text(json.dumps(cookies, indent=2))
        await context.close()

    # Verify
    check = json.loads(Path(GOOGLE_COOKIES_PATH).read_text())
    names = {c.get('name') for c in check}
    found = AUTH_COOKIES.intersection(names)
    print("-" * 64)
    print(f"  Saved {len(check)} cookies → {GOOGLE_COOKIES_PATH}")
    if found:
        print(f"  ✓ Auth cookies present: {sorted(found)}")
        print("  ✓ Capture looks good.")
        return True
    print("  ✗ NO Google auth cookies found — login likely did not complete.")
    print("    Re-run and make sure you finish sign-in BEFORE pressing Enter.")
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true',
                    help='Re-capture even if existing cookies look valid')
    args = ap.parse_args()

    if not args.force and cookies_are_valid():
        print("[SETUP] ✓ Google cookies are valid — skipping (use --force to redo)")
        sys.exit(0)

    ok = asyncio.run(run_manual_capture())
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
