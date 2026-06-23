#!/bin/bash
set -e

# ── Config ───────────────────────────────────────────────
EC2_HOST="107.23.203.205"
EC2_USER="ubuntu"
EC2_KEY="~/.ssh/id_rsa"
APP_DIR="/home/ubuntu/pinntag-dop"
PM2_APP_NAME="pinntag-dop-api"

# ── Colors ───────────────────────────────────────────────
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  PinnTag DOP — API Deploy${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Step 1: Build API locally ─────────────────────────────
echo -e "${CYAN}[1/5] Building API...${NC}"
cd "$(dirname "$0")/.."
cd apps/api
npm run build
echo -e "${GREEN}  ✓ Build complete${NC}"

# ── Step 2: Sync files to EC2 ─────────────────────────────
echo -e "${CYAN}[2/5] Syncing files to EC2...${NC}"
cd ../..

# Create app directory on EC2
ssh -i $EC2_KEY $EC2_USER@$EC2_HOST \
  "mkdir -p $APP_DIR/apps/api"

# Sync built files (exclude node_modules, .env)
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'src' \
  -e "ssh -i $EC2_KEY" \
  apps/api/dist/ \
  $EC2_USER@$EC2_HOST:$APP_DIR/apps/api/dist/

# Sync package.json for dependencies
rsync -avz \
  -e "ssh -i $EC2_KEY" \
  apps/api/package.json \
  apps/api/package-lock.json \
  $EC2_USER@$EC2_HOST:$APP_DIR/apps/api/

# Sync nest-cli.json and any asset files
rsync -avz \
  -e "ssh -i $EC2_KEY" \
  apps/api/nest-cli.json \
  $EC2_USER@$EC2_HOST:$APP_DIR/apps/api/

echo -e "${GREEN}  ✓ Files synced${NC}"

# ── Step 3: Install dependencies on EC2 ──────────────────
echo -e "${CYAN}[3/5] Installing dependencies on EC2...${NC}"
ssh -i $EC2_KEY $EC2_USER@$EC2_HOST "
  cd $APP_DIR/apps/api
  npm install --production --silent
"
echo -e "${GREEN}  ✓ Dependencies installed${NC}"

# ── Step 4: Restart with PM2 ─────────────────────────────
echo -e "${CYAN}[4/5] Restarting API with PM2...${NC}"
ssh -i $EC2_KEY $EC2_USER@$EC2_HOST "
  cd $APP_DIR/apps/api

  # Start or restart PM2 process
  if pm2 describe $PM2_APP_NAME > /dev/null 2>&1; then
    pm2 restart $PM2_APP_NAME
    echo 'Restarted existing PM2 process'
  else
    pm2 start dist/main.js \
      --name $PM2_APP_NAME \
      --env production \
      -i 1
    echo 'Started new PM2 process'
  fi

  pm2 save
"
echo -e "${GREEN}  ✓ PM2 restarted${NC}"

# ── Step 5: Health check ──────────────────────────────────
echo -e "${CYAN}[5/5] Health check...${NC}"
sleep 3
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  http://$EC2_HOST:3003/api/v1/health || echo "000")

if [ "$HTTP_STATUS" = "200" ]; then
  echo -e "${GREEN}  ✓ API is healthy (HTTP $HTTP_STATUS)${NC}"
else
  echo -e "  ⚠ Health check returned HTTP $HTTP_STATUS"
  echo -e "  Check logs: ssh -i $EC2_KEY $EC2_USER@$EC2_HOST 'pm2 logs $PM2_APP_NAME'"
fi

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  API deployed to: http://$EC2_HOST:3003"
echo -e "  Domain: https://dop-api.pinntag.com"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
