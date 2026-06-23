#!/bin/bash
set -e

# ── Config ───────────────────────────────────────────────
S3_BUCKET="pinntag-dop-portal"
CLOUDFRONT_DISTRIBUTION_ID="E3CF1BZKZWSEJK"  # Fill in after CF created
AWS_REGION="us-east-1"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  PinnTag DOP — Portal Deploy${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Step 1: Build portal ──────────────────────────────────
echo -e "${CYAN}[1/4] Building portal...${NC}"
cd "$(dirname "$0")/.."
cd apps/portal

# Use production env
cp .env.production .env.local 2>/dev/null || true
npm run build
echo -e "${GREEN}  ✓ Build complete (dist/)${NC}"

# ── Step 2: Sync to S3 ───────────────────────────────────
echo -e "${CYAN}[2/4] Uploading to S3...${NC}"
cd ../..

# Upload all files
aws s3 sync apps/portal/dist/ s3://$S3_BUCKET/ \
  --region $AWS_REGION \
  --delete \
  --cache-control "public, max-age=31536000" \
  --exclude "index.html"

# Upload index.html with no-cache (always fresh)
aws s3 cp apps/portal/dist/index.html \
  s3://$S3_BUCKET/index.html \
  --region $AWS_REGION \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html"

echo -e "${GREEN}  ✓ Uploaded to S3${NC}"

# ── Step 3: Invalidate CloudFront cache ──────────────────
echo -e "${CYAN}[3/4] Invalidating CloudFront cache...${NC}"
if [ -n "$CLOUDFRONT_DISTRIBUTION_ID" ]; then
  aws cloudfront create-invalidation \
    --distribution-id $CLOUDFRONT_DISTRIBUTION_ID \
    --paths "/*" \
    --region $AWS_REGION
  echo -e "${GREEN}  ✓ Cache invalidated${NC}"
else
  echo -e "${YELLOW}  ⚠ CLOUDFRONT_DISTRIBUTION_ID not set — skipping${NC}"
  echo -e "  Set it in deploy/deploy-portal.sh after CloudFront is created"
fi

# ── Step 4: Done ─────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Portal deployed to: https://dop.pinntag.com"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
