# PinnTag DOP Bot — Setup Guide

## Mac

1. Open **Terminal**
   (Press Cmd+Space, type Terminal, press Enter)

2. Paste this command and press Enter:

curl -fsSL https://dop.pinntag.com/bot-source/install.sh | bash

3. A Google login window will open — sign in to your
   Google account. The window closes automatically.

4. The bot starts and the portal opens in your browser.

**Next time:** Double-click **PinnTag DOP Bot**
on your Desktop.

---

## Ubuntu / Linux

1. Open **Terminal**

2. Paste this command and press Enter:

curl -fsSL https://dop.pinntag.com/bot-source/install.sh | bash

3. Enter your password if asked (for system packages)

4. A Google login window will open — sign in.

5. The bot starts and the portal opens.

**Next time:** Double-click **PinnTag DOP Bot**
on your Desktop.

---

## Windows

1. Press **Windows key + R**

2. Type `powershell` and press Enter

3. Paste this command and press Enter:

irm https://dop.pinntag.com/bot-source/install.ps1 | iex

4. A Google login window will open — sign in.

5. The bot starts and the portal opens.

**Next time:** Double-click **PinnTag DOP Bot**
on your Desktop.

---

## What installs automatically

- Python 3.11 (if not already installed)
- All required packages
- Chromium browser for scraping
- Google session for reviews
- Desktop shortcut for easy access

## If reviews stop working

The Google session expires after ~25 days.
To refresh it, delete the file `google_cookies.json`
from the `pinntag-dop-bot` folder in your home
directory, then restart the bot.

## Need help?

Contact your PinnTag administrator.
