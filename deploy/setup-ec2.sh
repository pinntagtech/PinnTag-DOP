#!/bin/bash
# Run this ONCE on the EC2 instance to set up the environment
# ssh -i ~/.ssh/pinntag.pem ubuntu@107.23.203.205
# Then: bash setup-ec2.sh

set -e

echo "Setting up PinnTag DOP on EC2..."

# ── Install Node 22 ───────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# ── Install PM2 ───────────────────────────────────────────
sudo npm install -g pm2
pm2 startup systemd -u ubuntu --hp /home/ubuntu
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu

# ── Create app directory ──────────────────────────────────
mkdir -p /home/ubuntu/pinntag-dop/apps/api

# ── Install certbot ───────────────────────────────────────
sudo apt-get install -y certbot python3-certbot-nginx

echo ""
echo "EC2 setup complete!"
echo ""
echo "Next steps:"
echo "1. Copy .env.production to /home/ubuntu/pinntag-dop/apps/api/.env"
echo "2. Run deploy/deploy-api.sh from your Mac"
echo "3. Copy nginx config: sudo cp nginx-dop-api.conf /etc/nginx/sites-available/dop-api"
echo "4. Enable: sudo ln -s /etc/nginx/sites-available/dop-api /etc/nginx/sites-enabled/"
echo "5. Get SSL: sudo certbot --nginx -d dop-api.pinntag.com"
echo "6. Reload nginx: sudo nginx -s reload"
