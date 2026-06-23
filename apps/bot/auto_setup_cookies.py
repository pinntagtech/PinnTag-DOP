import asyncio
import json
import os
import sys
from pathlib import Path
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

GOOGLE_COOKIES_PATH = os.getenv(
    'GOOGLE_COOKIES_PATH', './google_cookies.json'
)
COOKIE_MAX_AGE_DAYS = 25  # refresh before 30-day expiry


def cookies_are_valid() -> bool:
    """Check if cookies exist and are fresh enough."""
    path = Path(GOOGLE_COOKIES_PATH)
    if not path.exists():
        return False

    # Check file age
    mtime = path.stat().st_mtime
    age_days = (datetime.now().timestamp() - mtime) / 86400
    if age_days > COOKIE_MAX_AGE_DAYS:
        print(f"[SETUP] Cookies are {age_days:.0f} days old — refreshing")
        return False

    # Check file has content
    try:
        cookies = json.loads(path.read_text())
        if not isinstance(cookies, list) or len(cookies) < 5:
            return False
        # Check for key Google auth cookies
        names = {c.get('name') for c in cookies}
        required = {'SID', 'HSID', 'SSID', 'APISID', 'SAPISID'}
        if not required.intersection(names):
            print("[SETUP] Cookies missing Google auth tokens — refreshing")
            return False
        return True
    except Exception:
        return False


async def run_google_login():
    """Open browser for Google login and save cookies."""
    from playwright.async_api import async_playwright

    print("[SETUP] Opening browser for Google login...")
    print("[SETUP] Please log into your Google account")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=[
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--no-default-browser-check',
                '--window-size=1000,700',
            ],
        )

        context = await browser.new_context(
            viewport={'width': 1000, 'height': 700},
            locale='en-US',
            user_agent=(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/124.0.0.0 Safari/537.36'
            ),
        )

        page = await context.new_page()

        # Navigate to Google sign-in
        await page.goto(
            'https://accounts.google.com/signin',
            wait_until='domcontentloaded',
        )

        # Inject instruction banner into the page
        try:
            await page.evaluate("""
                const banner = document.createElement('div');
                banner.id = 'dop-banner';
                banner.style.cssText = [
                    'position:fixed',
                    'top:0',
                    'left:0',
                    'right:0',
                    'background:#1a1a2e',
                    'color:#ffffff',
                    'padding:12px 20px',
                    'font-family:-apple-system,sans-serif',
                    'font-size:14px',
                    'font-weight:500',
                    'z-index:999999',
                    'display:flex',
                    'align-items:center',
                    'gap:12px',
                    'box-shadow:0 2px 8px rgba(0,0,0,0.4)'
                ].join(';');

                const icon = document.createElement('span');
                icon.textContent = '🔐';
                icon.style.fontSize = '20px';

                const text = document.createElement('span');
                const strong = document.createElement('strong');
                strong.textContent = 'PinnTag DOP Setup';
                text.appendChild(strong);
                text.appendChild(document.createTextNode(
                    ' — Please sign in to your Google account. ' +
                    'The window will close automatically once done.'
                ));

                banner.appendChild(icon);
                banner.appendChild(text);
                document.body.prepend(banner);
            """)
        except Exception:
            pass  # Banner is cosmetic — login still works

        print("[SETUP] Waiting for Google login...")
        print("[SETUP] The browser window will close automatically")

        # Poll until logged in (myaccount.google.com accessible)
        logged_in = False
        for attempt in range(120):  # wait up to 4 minutes
            await asyncio.sleep(2)

            try:
                current_url = page.url

                # Check if redirected away from signin
                if 'accounts.google.com/signin' not in current_url:
                    # Navigate to maps to confirm login
                    await page.goto(
                        'https://www.google.com/maps',
                        wait_until='domcontentloaded',
                        timeout=15000,
                    )
                    await asyncio.sleep(2)

                    # Check if logged in by looking for
                    # account avatar
                    avatar = await page.query_selector(
                        'a[aria-label*="Google Account"],'
                        'img[aria-label*="Google Account"],'
                        '[data-ogsr-up]'
                    )

                    if avatar:
                        logged_in = True
                        print("[SETUP] ✓ Google login detected!")
                        break

                    # Go back to signin if not logged in
                    if 'accounts.google.com' in page.url:
                        continue

            except Exception:
                continue

        if not logged_in:
            print("[SETUP] ✗ Login timeout — please try again")
            await browser.close()
            return False

        # Save cookies
        print("[SETUP] Saving session cookies...")
        await asyncio.sleep(2)

        cookies = await context.cookies([
            'https://google.com',
            'https://www.google.com',
            'https://maps.google.com',
            'https://accounts.google.com',
        ])

        Path(GOOGLE_COOKIES_PATH).write_text(
            json.dumps(cookies, indent=2)
        )

        print(f"[SETUP] ✓ Saved {len(cookies)} cookies to "
              f"{GOOGLE_COOKIES_PATH}")

        # Show success message in browser
        try:
            await page.evaluate("""
                const banner = document.getElementById('dop-banner');
                if (banner) {
                    banner.style.background = '#065f46';
                    while (banner.firstChild) {
                        banner.removeChild(banner.firstChild);
                    }
                    const icon = document.createElement('span');
                    icon.textContent = '✅';
                    icon.style.fontSize = '20px';

                    const text = document.createElement('span');
                    const strong = document.createElement('strong');
                    strong.textContent = 'Setup complete!';
                    text.appendChild(strong);
                    text.appendChild(document.createTextNode(
                        ' — This window will close in 3 seconds.'
                    ));

                    banner.appendChild(icon);
                    banner.appendChild(text);
                }
            """)
        except Exception:
            pass  # Banner is cosmetic — login still works

        await asyncio.sleep(3)
        await browser.close()
        return True


def main():
    if cookies_are_valid():
        print("[SETUP] ✓ Google cookies are valid — skipping login")
        sys.exit(0)

    print("[SETUP] Google login required...")
    success = asyncio.run(run_google_login())
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
