#!/bin/bash
# PinnTag DOP Bot — One-click installer (Mac / Ubuntu / Linux)
#
# All bot files are now served through the authenticated DOP API. The
# operator needs:
#   1. The bot secret (x-bot-secret) — distributed by DOP admin.
#   2. The API URL (defaults to https://dop-api.pinntag.com).
#
# Usage:
#   export DOP_BOT_SECRET="<secret>"
#   curl -fsSL <install-host>/install.sh | bash
# Or:
#   DOP_BOT_SECRET=<secret> bash install.sh

set -e

# ── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

BOT_DIR="$HOME/pinntag-dop-bot"
DOP_API_URL="${DOP_API_URL:-https://dop-api.pinntag.com}"
DOP_BOT_SECRET="${DOP_BOT_SECRET:-${DOP_API_WEBHOOK_SECRET:-}}"
API_BASE="$DOP_API_URL/api/v1/seeding/bot/source"

OS="$(uname -s)"

# ── Secret check ──────────────────────────────────────────
if [ -z "$DOP_BOT_SECRET" ]; then
    printf "${RED}DOP_BOT_SECRET is required.${NC}\n"
    printf "Get it from your DOP admin, then:\n"
    printf "  export DOP_BOT_SECRET=<secret>\n"
    printf "  bash install.sh\n"
    exit 1
fi

# ── Auth-aware download helper ────────────────────────────
api_download() {
    local name="$1"
    local dest="$2"
    if command -v curl &>/dev/null; then
        curl -fsSL \
            -H "x-bot-secret: $DOP_BOT_SECRET" \
            "$API_BASE/file/$name" \
            -o "$dest"
    elif command -v wget &>/dev/null; then
        wget -q \
            --header="x-bot-secret: $DOP_BOT_SECRET" \
            "$API_BASE/file/$name" -O "$dest"
    else
        printf "${RED}  ✗ Neither curl nor wget found${NC}\n"
        if [ "$OS" = "Linux" ]; then
            sudo apt-get install -y curl -qq > /dev/null 2>&1
            api_download "$name" "$dest"
        else
            printf "${RED}  Install curl and retry.${NC}\n"
            exit 1
        fi
    fi
}

clear
printf "\n"
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf "${BOLD}  PinnTag DOP — Bot Setup${NC}\n"
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf "\n"
printf "  Installing the PinnTag DOP bot.\n"
printf "  API: $DOP_API_URL\n"
printf "\n"

# ── Step 1: Python ────────────────────────────────────────
printf "${CYAN}[1/6] Checking Python...${NC}\n"
if command -v python3 &>/dev/null; then
    PY_VER=$(python3 --version 2>&1)
    printf "${GREEN}  ✓ $PY_VER${NC}\n"
else
    if [ "$OS" = "Darwin" ]; then
        printf "  Installing Python via Homebrew...\n"
        if ! command -v brew &>/dev/null; then
            printf "  Installing Homebrew first...\n"
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        brew install python3 -q
    elif [ "$OS" = "Linux" ]; then
        printf "  Installing Python...\n"
        sudo apt-get update -qq
        sudo apt-get install -y python3 python3-pip python3-venv -qq
    fi
    printf "${GREEN}  ✓ Python installed${NC}\n"
fi

# ── Step 2: System deps (Linux only) ─────────────────────
if [ "$OS" = "Linux" ]; then
    printf "${CYAN}[2/6] Installing system dependencies...${NC}\n"
    sudo apt-get install -y -qq --no-install-recommends \
        curl wget \
        libnss3 libnspr4 libdrm2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxfixes3 \
        libxrandr2 libgbm1 \
        > /dev/null 2>&1
    printf "${GREEN}  ✓ Done${NC}\n"
else
    printf "${CYAN}[2/6] Checking system dependencies...${NC}\n"
    printf "${GREEN}  ✓ Mac — no extra deps needed${NC}\n"
fi

# ── Step 3: Download bot files ────────────────────────────
printf "${CYAN}[3/6] Downloading bot files from API...${NC}\n"
mkdir -p "$BOT_DIR"

# Whitelist — must match API BOT_SOURCE_WHITELIST.
# .env is created locally below, NOT fetched (it holds the operator's
# secret + env choice which the API doesn't store).
for file in main.py scraper_bulk.py auto_setup_cookies.py requirements.txt version.json; do
    printf "  ↓ $file\n"
    api_download "$file" "$BOT_DIR/$file"
done

# ── Write local .env if missing ──────────────────────────
if [ ! -f "$BOT_DIR/.env" ]; then
    cat > "$BOT_DIR/.env" <<EOF
# PinnTag DOP Bot Configuration
DOP_API_URL_DEV=http://localhost:3000
DOP_API_URL_PRE_PROD=https://dop-api.pinntag.com
DOP_API_URL_STAGING=https://dop-api.pinntag.com
DOP_API_URL_PRODUCTION=https://dop-api.pinntag.com

DOP_ENV=staging

DOP_API_WEBHOOK_SECRET=$DOP_BOT_SECRET

GOOGLE_COOKIES_PATH=./google_cookies.json
MAX_REVIEWS=100
MAX_GALLERY_PER_FOLDER=50
HEADLESS=false
LOG_LEVEL=INFO
EOF
    printf "${GREEN}  ✓ Wrote $BOT_DIR/.env${NC}\n"
else
    printf "${YELLOW}  ⚠ Keeping existing .env${NC}\n"
fi

printf "${GREEN}  ✓ Bot files downloaded to $BOT_DIR${NC}\n"

# ── Step 4: Python dependencies ───────────────────────────
printf "${CYAN}[4/6] Installing Python dependencies...${NC}\n"
cd "$BOT_DIR"

python3 -m venv venv > /dev/null 2>&1
# shellcheck disable=SC1091
source venv/bin/activate

pip install -q -r requirements.txt 2>/dev/null || \
pip install -q -r requirements.txt --break-system-packages 2>/dev/null || \
python3 -m pip install -q -r requirements.txt 2>/dev/null

if ! python3 -c "import fastapi" 2>/dev/null; then
    printf "${RED}  ✗ Failed to install dependencies${NC}\n"
    exit 1
fi
printf "${GREEN}  ✓ Dependencies installed${NC}\n"

# ── Step 5: Playwright Chromium ───────────────────────────
printf "${CYAN}[5/6] Installing Chromium browser...${NC}\n"
PLAYWRIGHT_BIN="$BOT_DIR/venv/bin/playwright"
if [ ! -f "$PLAYWRIGHT_BIN" ]; then
    printf "${RED}  ✗ Playwright not found in venv${NC}\n"
    exit 1
fi
printf "  Installing Chromium (this may take a minute)...\n"
"$PLAYWRIGHT_BIN" install chromium 2>&1 | grep -v "^$" | grep -v "Downloading" || true
if "$PLAYWRIGHT_BIN" install chromium > /dev/null 2>&1; then
    printf "${GREEN}  ✓ Chromium installed${NC}\n"
else
    printf "${YELLOW}  ⚠ Chromium install had warnings${NC}\n"
fi

# ── Step 6: Google login ──────────────────────────────────
printf "${CYAN}[6/6] Setting up Google session...${NC}\n"
python3 auto_setup_cookies.py
if [ $? -eq 0 ]; then
    printf "${GREEN}  ✓ Google session ready${NC}\n"
else
    printf "${YELLOW}  ⚠ Google login skipped — reviews disabled${NC}\n"
fi

# ── Create run script ─────────────────────────────────────
cat > "$BOT_DIR/start.sh" << 'RUNSCRIPT'
#!/bin/bash
cd "$(dirname "$0")"

if [ -f venv/bin/activate ]; then
    source venv/bin/activate
elif [ -f venv/Scripts/activate ]; then
    source venv/Scripts/activate
fi

if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "  Installing missing dependencies..."
    pip install -q -r requirements.txt 2>/dev/null || \
    pip install -q -r requirements.txt --break-system-packages 2>/dev/null
fi

if ! python3 -c "from playwright.sync_api import sync_playwright" 2>/dev/null; then
    echo "  Installing Playwright..."
    pip install -q playwright 2>/dev/null
    playwright install chromium 2>/dev/null
fi

printf "\n"
printf "  PinnTag DOP Bot starting...\n"
printf "  Opening portal at https://dop.pinntag.com\n\n"

if command -v open &>/dev/null; then
    open "https://dop.pinntag.com"
elif command -v xdg-open &>/dev/null; then
    xdg-open "https://dop.pinntag.com" &
fi

cleanup() {
    printf "\n  Bot stopped.\n"
    exit 0
}
trap cleanup SIGINT SIGTERM

uvicorn main:app --host 0.0.0.0 --port 8000
RUNSCRIPT

chmod +x "$BOT_DIR/start.sh"

# ── Desktop shortcut (Mac) ────────────────────────────────
if [ "$OS" = "Darwin" ]; then
    SHORTCUT="$HOME/Desktop/PinnTag DOP Bot.command"
    cat > "$SHORTCUT" << SHORTCUTSCRIPT
#!/bin/bash
cd "$BOT_DIR"
source venv/bin/activate
open "https://dop.pinntag.com"
cleanup() { printf "\n  Bot stopped.\n"; exit 0; }
trap cleanup SIGINT SIGTERM
uvicorn main:app --host 0.0.0.0 --port 8000
SHORTCUTSCRIPT
    chmod +x "$SHORTCUT"
    printf "${GREEN}  ✓ Desktop shortcut created${NC}\n"
fi

# ── Desktop shortcut (Linux) ─────────────────────────────
if [ "$OS" = "Linux" ]; then
    DESKTOP="$HOME/Desktop/PinnTag-DOP-Bot.desktop"
    cat > "$DESKTOP" << DESKTOPFILE
[Desktop Entry]
Version=1.0
Type=Application
Name=PinnTag DOP Bot
Comment=PinnTag Data Operations Bot
Exec=bash $BOT_DIR/start.sh
Terminal=true
Categories=Application;
DESKTOPFILE
    chmod +x "$DESKTOP"
    printf "${GREEN}  ✓ Desktop shortcut created${NC}\n"
fi

printf "\n"
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf "${GREEN}${BOLD}  Setup complete!${NC}\n"
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf "\n"
printf "  Manual update one-liner:\n"
printf "    curl -sSL -H \"x-bot-secret: \$SECRET\" \\\\\n"
printf "      $API_BASE/file/update.sh | bash\n"
printf "\n"
printf "  Self-update runs automatically on every bot start.\n"
printf "\n"
printf "  Starting bot now...\n"
printf "  Portal opening at https://dop.pinntag.com\n"
printf "\n"

cd "$BOT_DIR"
if command -v open &>/dev/null; then
    open "https://dop.pinntag.com"
elif command -v xdg-open &>/dev/null; then
    xdg-open "https://dop.pinntag.com" &
fi

cleanup() {
    printf "\n  Bot stopped. Goodbye!\n"
    exit 0
}
trap cleanup SIGINT SIGTERM

uvicorn main:app --host 0.0.0.0 --port 8000
