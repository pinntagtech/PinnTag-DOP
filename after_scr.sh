cat > /tmp/create-cf.sh << 'SCRIPT'
#!/bin/bash
S3_BUCKET="pinntag-dop-portal"
AWS_REGION="us-east-1"
DOMAIN="dop.pinntag.com"
CERT_ARN="arn:aws:acm:us-east-1:692859910391:certificate/3ad7ca54-1f8c-444a-b672-411ed7b0e59a"
S3_WEBSITE_ENDPOINT="${S3_BUCKET}.s3-website-${AWS_REGION}.amazonaws.com"

cat > /tmp/cf-config.json << EOF
{
  "CallerReference": "dop-portal-$(date +%s)",
  "Comment": "PinnTag DOP Portal",
  "DefaultCacheBehavior": {
    "TargetOriginId": "S3-${S3_BUCKET}",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
    "ForwardedValues": {"QueryString": false, "Cookies": {"Forward": "none"}},
    "Compress": true,
    "DefaultTTL": 86400,
    "MinTTL": 0,
    "MaxTTL": 31536000
  },
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "S3-${S3_BUCKET}",
      "DomainName": "${S3_WEBSITE_ENDPOINT}",
      "CustomOriginConfig": {
        "HTTPPort": 80,
        "HTTPSPort": 443,
        "OriginProtocolPolicy": "http-only"
      }
    }]
  },
  "CustomErrorResponses": {
    "Quantity": 1,
    "Items": [{
      "ErrorCode": 403,
      "ResponsePagePath": "/index.html",
      "ResponseCode": "200",
      "ErrorCachingMinTTL": 0
    }]
  },
  "Aliases": {"Quantity": 1, "Items": ["${DOMAIN}"]},
  "ViewerCertificate": {
    "ACMCertificateArn": "${CERT_ARN}",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  },
  "Enabled": true,
  "HttpVersion": "http2",
  "DefaultRootObject": "index.html"
}
EOF

CF_RESULT=$(aws cloudfront create-distribution \
  --region us-east-1 \
  --distribution-config file:///tmp/cf-config.json)

CF_DOMAIN=$(echo $CF_RESULT | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Distribution']['DomainName'])")
CF_ID=$(echo $CF_RESULT | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Distribution']['Id'])")

echo ""
echo "CloudFront created!"
echo "Distribution ID: $CF_ID"
echo "CloudFront domain: $CF_DOMAIN"
echo ""
echo "Add in Cloudflare: dop.pinntag.com CNAME $CF_DOMAIN"
echo "Update deploy-portal.sh: CLOUDFRONT_DISTRIBUTION_ID=$CF_ID"
SCRIPT

bash /tmp/create-cf.sh
