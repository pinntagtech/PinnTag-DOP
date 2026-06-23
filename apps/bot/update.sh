#!/bin/bash
# PinnTag DOP Bot — manual update (operator-run one-liner)
#
# Fetched live from the DOP API so the script logic itself can be
# updated by uploading a new copy to s3://pinntag-dop-portal/bot-source/.
#
# Operator usage (the only thing they need to remember):
#   curl -sSL -H "x-bot-secret: $SECRET" \
#     https://dop-api.pinntag.com/api/v1/seeding/bot/source/file/update.sh | bash
#
# SECRET comes from their bot .env (DOP_API_WEBHOOK_SECRET).

set -e

BOT_DIR="${BOT_DIR:-$HOME/pinntag-dop-bot}"

if [ ! -d "$BOT_DIR" ]; then
    echo "Bot directory not found: $BOT_DIR"
    echo "Run install.sh first."
    exit 1
fi

cd "$BOT_DIR"

# ── Load secret + API URL from .env ───────────────────────────
if [ ! -f .env ]; then
    echo ".env not found in $BOT_DIR — cannot authenticate to API"
    exit 1
fi

# shellcheck disable=SC1091
set -a
# shellcheck disable=SC1091
. ./.env
set +a

SECRET="${DOP_API_WEBHOOK_SECRET:-}"
if [ -z "$SECRET" ]; then
    echo "DOP_API_WEBHOOK_SECRET not set in $BOT_DIR/.env"
    exit 1
fi

ENV_KEY="$(echo "${DOP_ENV:-staging}" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
ENV_URL_VAR="DOP_API_URL_${ENV_KEY}"
API="${!ENV_URL_VAR:-${DOP_API_URL:-https://dop-api.pinntag.com}}"
BASE="$API/api/v1/seeding/bot/source"

echo "──────────────────────────────────────────────"
echo "  PinnTag DOP — manual bot update"
echo "  API: $API"
echo "──────────────────────────────────────────────"

# ── Files to refresh — must match API whitelist ─────────────
# Never touch google_cookies.json or .env.
FILES=(main.py scraper_bulk.py auto_setup_cookies.py requirements.txt version.json)

for f in "${FILES[@]}"; do
    echo "  ↓ $f"
    if ! curl -fsSL \
        -H "x-bot-secret: $SECRET" \
        "$BASE/file/$f" \
        -o "$BOT_DIR/$f.new"; then
        echo "    ✗ failed to fetch $f — aborting (no files overwritten)"
        rm -f "$BOT_DIR"/*.new
        exit 1
    fi
done

# All downloads succeeded — commit them atomically (per file).
for f in "${FILES[@]}"; do
    mv "$BOT_DIR/$f.new" "$BOT_DIR/$f"
done

echo ""
echo "  ✓ Source updated"

# ── Reinstall Python deps if requirements changed ───────────
if [ -f "$BOT_DIR/venv/bin/pip" ]; then
    echo "  Refreshing Python dependencies..."
    "$BOT_DIR/venv/bin/pip" install -q -r "$BOT_DIR/requirements.txt" 2>/dev/null || \
        "$BOT_DIR/venv/bin/pip" install -q -r "$BOT_DIR/requirements.txt" \
            --break-system-packages 2>/dev/null || true
fi

# ── Restart bot if it's running ─────────────────────────────
if pgrep -f "uvicorn main:app" > /dev/null; then
    echo "  Restarting bot..."
    pkill -f "uvicorn main:app" || true
    sleep 1
    nohup "$BOT_DIR/venv/bin/uvicorn" main:app \
        --host 0.0.0.0 --port 8000 \
        > "$BOT_DIR/bot.log" 2>&1 &
    disown || true
    echo "  ✓ Bot restarted (log: $BOT_DIR/bot.log)"
else
    echo "  Bot was not running — start it via the desktop shortcut or start.sh"
fi

echo ""
echo "  Done. Current version:"
cat "$BOT_DIR/version.json" 2>/dev/null || echo "  (no version.json)"
echo ""
