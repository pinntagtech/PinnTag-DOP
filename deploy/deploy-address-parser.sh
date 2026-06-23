#!/usr/bin/env bash
set -euo pipefail

EC2_HOST="ubuntu@107.23.203.205"
SSH_KEY="$HOME/.ssh/id_rsa"
LOCAL_DIR="apps/address-parser/"
REMOTE_DIR="/home/ubuntu/pinntag-dop/apps/address-parser/"

echo "[1/3] Syncing address-parser to EC2..."
rsync -avz -e "ssh -i $SSH_KEY" \
  "$LOCAL_DIR" "$EC2_HOST:$REMOTE_DIR" \
  --exclude venv --exclude __pycache__ --exclude .env --exclude "*.pyc"

echo "[2/3] Installing deps + restarting parser on EC2..."
ssh -i "$SSH_KEY" "$EC2_HOST" bash -s << 'EOF'
  set -e
  cd /home/ubuntu/pinntag-dop/apps/address-parser
  source venv/bin/activate
  pip install -q -r requirements.txt
  pm2 restart pinntag-dop-address-parser --update-env
EOF

echo "[3/3] Health check..."
ssh -i "$SSH_KEY" "$EC2_HOST" "curl -s http://localhost:4101/health"
echo
echo "Done."
