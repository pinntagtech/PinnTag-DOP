# PinnTag Bot Service

FastAPI service that scrapes Google Maps data for seeded businesses.

## Setup

pip install -r requirements.txt
playwright install chromium

## Save Google cookies (run once)

python save_cookies.py

## Start the service

uvicorn main:app --host 0.0.0.0 --port 8000 --reload

## Endpoints

GET  /health          — health check
POST /scrape          — trigger scrape for a business
GET  /scrape/{id}/status — check scrape status

## Trigger manually

curl -X POST http://localhost:8000/scrape \
  -H "Content-Type: application/json" \
  -H "x-bot-secret: pinntag_bot_2026" \
  -d '{
    "placeId": "ChIJ...",
    "businessId": "...",
    "businessName": "Test Place",
    "environment": "dev"
  }'
