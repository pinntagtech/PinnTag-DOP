#!/bin/bash
# Run this ONCE from your Mac to set up S3 + CloudFront
set -e

S3_BUCKET="pinntag-dop-portal"
AWS_REGION="us-east-1"
DOMAIN="dop.pinntag.com"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}Setting up S3 + CloudFront for DOP Portal${NC}"
echo ""

# ── Create S3 bucket ──────────────────────────────────────
echo -e "${CYAN}[1/4] Creating S3 bucket...${NC}"
aws s3api create-bucket \
  --bucket $S3_BUCKET \
  --region $AWS_REGION 2>/dev/null || echo "  Bucket already exists"

# Disable block public access
aws s3api put-public-access-block \
  --bucket $S3_BUCKET \
  --public-access-block-configuration \
  "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

# Set bucket policy for public read
aws s3api put-bucket-policy \
  --bucket $S3_BUCKET \
  --policy "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"PublicReadGetObject\",
      \"Effect\": \"Allow\",
      \"Principal\": \"*\",
      \"Action\": \"s3:GetObject\",
      \"Resource\": \"arn:aws:s3:::$S3_BUCKET/*\"
    }]
  }"

# Enable static website hosting
aws s3api put-bucket-website \
  --bucket $S3_BUCKET \
  --website-configuration '{
    "IndexDocument": {"Suffix": "index.html"},
    "ErrorDocument": {"Key": "index.html"}
  }'

echo -e "${GREEN}  ✓ S3 bucket ready${NC}"

# ── Request ACM certificate ───────────────────────────────
echo -e "${CYAN}[2/4] Requesting SSL certificate from ACM...${NC}"
echo -e "  NOTE: Certificate must be in us-east-1 for CloudFront"
CERT_ARN=$(aws acm request-certificate \
  --domain-name "$DOMAIN" \
  --validation-method DNS \
  --region us-east-1 \
  --query 'CertificateArn' \
  --output text)

echo -e "${GREEN}  ✓ Certificate requested: $CERT_ARN${NC}"
echo -e "  ⚠ Add the DNS validation record in Route53/your DNS"
echo -e "  Then wait for validation before continuing"
echo ""
read -p "Press Enter once DNS validation is complete..."

# ── Create CloudFront distribution ───────────────────────
echo -e "${CYAN}[3/4] Creating CloudFront distribution...${NC}"

S3_WEBSITE_ENDPOINT="$S3_BUCKET.s3-website-$AWS_REGION.amazonaws.com"

CF_RESULT=$(aws cloudfront create-distribution \
  --region us-east-1 \
  --distribution-config "{
    \"CallerReference\": \"dop-portal-$(date +%s)\",
    \"Comment\": \"PinnTag DOP Portal\",
    \"DefaultCacheBehavior\": {
      \"TargetOriginId\": \"S3-$S3_BUCKET\",
      \"ViewerProtocolPolicy\": \"redirect-to-https\",
      \"AllowedMethods\": {
        \"Quantity\": 2,
        \"Items\": [\"GET\", \"HEAD\"]
      },
      \"ForwardedValues\": {
        \"QueryString\": false,
        \"Cookies\": {\"Forward\": \"none\"}
      },
      \"Compress\": true,
      \"DefaultTTL\": 86400,
      \"MinTTL\": 0,
      \"MaxTTL\": 31536000
    },
    \"Origins\": {
      \"Quantity\": 1,
      \"Items\": [{
        \"Id\": \"S3-$S3_BUCKET\",
        \"DomainName\": \"$S3_WEBSITE_ENDPOINT\",
        \"CustomOriginConfig\": {
          \"HTTPPort\": 80,
          \"HTTPSPort\": 443,
          \"OriginProtocolPolicy\": \"http-only\"
        }
      }]
    },
    \"CustomErrorResponses\": {
      \"Quantity\": 1,
      \"Items\": [{
        \"ErrorCode\": 403,
        \"ResponsePagePath\": \"/index.html\",
        \"ResponseCode\": \"200\",
        \"ErrorCachingMinTTL\": 0
      }]
    },
    \"Aliases\": {
      \"Quantity\": 1,
      \"Items\": [\"$DOMAIN\"]
    },
    \"ViewerCertificate\": {
      \"ACMCertificateArn\": \"$CERT_ARN\",
      \"SSLSupportMethod\": \"sni-only\",
      \"MinimumProtocolVersion\": \"TLSv1.2_2021\"
    },
    \"Enabled\": true,
    \"HttpVersion\": \"http2\",
    \"DefaultRootObject\": \"index.html\"
  }")

CF_DOMAIN=$(echo $CF_RESULT | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   print(d['Distribution']['DomainName'])")
CF_ID=$(echo $CF_RESULT | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   print(d['Distribution']['Id'])")

echo -e "${GREEN}  ✓ CloudFront created${NC}"
echo -e "  Distribution ID: $CF_ID"
echo -e "  CloudFront domain: $CF_DOMAIN"

# ── Print DNS instructions ────────────────────────────────
echo ""
echo -e "${CYAN}[4/4] DNS setup required:${NC}"
echo ""
echo -e "${BOLD}Add these DNS records:${NC}"
echo ""
echo -e "  $DOMAIN  CNAME  $CF_DOMAIN"
echo ""
echo -e "${BOLD}Also add for EC2 API:${NC}"
echo -e "  dop-api.pinntag.com  A  107.23.203.205"
echo ""
echo -e "${BOLD}Update deploy/deploy-portal.sh:${NC}"
echo -e "  CLOUDFRONT_DISTRIBUTION_ID=\"$CF_ID\""
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Setup complete!"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
