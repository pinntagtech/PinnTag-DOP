#!/bin/bash
# Uploads bot source files to S3.
#
# The API reads from s3://pinntag-dop-portal/bot-source/ server-side
# and proxies the files (with x-bot-secret auth) to operators. Public
# S3 reads are blocked — this prefix is intentionally NOT public.
#
# Bumps version.json automatically (timestamp YYYY.MM.DD.HHMM) so a
# new upload always triggers operator self-update on next start.
set -e

S3_BUCKET="pinntag-dop-portal"
BOT_DIR="apps/bot"
S3_PREFIX="bot-source"

# ── Bump version.json ─────────────────────────────────────
# We always write a fresh stamp here — relying on someone to remember
# to edit version.json is exactly what we're trying to avoid.
NEW_VERSION="$(date -u +%Y.%m.%d.%H%M)"
echo "Stamping version.json -> $NEW_VERSION"
cat > "$BOT_DIR/version.json" <<EOF
{
  "version": "$NEW_VERSION"
}
EOF

echo "Uploading bot source to s3://$S3_BUCKET/$S3_PREFIX/ ..."

# ── Whitelist mirror ──────────────────────────────────────
# Must match BOT_SOURCE_WHITELIST in apps/api/src/modules/seeding/bot/
# bot-source.service.ts. Anything outside this list is rejected by the
# API, so uploading it is wasted bytes.
SOURCE_FILES=(
    main.py
    scraper_bulk.py
    auto_setup_cookies.py
    requirements.txt
    version.json
    update.sh
    update.ps1
)

for file in "${SOURCE_FILES[@]}"; do
    if [ ! -f "$BOT_DIR/$file" ]; then
        echo "  ! missing: $BOT_DIR/$file — skipping"
        continue
    fi
    aws s3 cp "$BOT_DIR/$file" \
        "s3://$S3_BUCKET/$S3_PREFIX/$file" \
        --cache-control "no-cache" \
        --region us-east-1
    echo "  ✓ Uploaded $file"
done

echo ""
echo "Bot source v$NEW_VERSION uploaded."
echo ""
echo "Operator manual-update one-liner (Mac/Linux):"
echo "  curl -sSL -H \"x-bot-secret: \$SECRET\" \\"
echo "    https://dop-api.pinntag.com/api/v1/seeding/bot/source/file/update.sh | bash"
echo ""
echo "Windows (PowerShell):"
echo "  \$env:SECRET=\"<secret>\"; irm -Headers @{\"x-bot-secret\"=\$env:SECRET} \\"
echo "    https://dop-api.pinntag.com/api/v1/seeding/bot/source/file/update.ps1 | iex"
echo ""
echo "Bots already running will self-update on next restart."
