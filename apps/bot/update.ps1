# PinnTag DOP Bot - manual update (Windows operator-run one-liner)
#
# Fetched live from the DOP API so this script itself can evolve via
# the upload-bot-source.sh deploy.
#
# Operator usage:
#   $env:SECRET="<from .env>"; `
#   irm -Headers @{"x-bot-secret"=$env:SECRET} `
#     https://dop-api.pinntag.com/api/v1/seeding/bot/source/file/update.ps1 | iex

$ErrorActionPreference = "Stop"
$BOT_DIR = if ($env:BOT_DIR) { $env:BOT_DIR } else { "$env:USERPROFILE\pinntag-dop-bot" }

if (-not (Test-Path $BOT_DIR)) {
    Write-Host "Bot directory not found: $BOT_DIR" -ForegroundColor Red
    Write-Host "Run install.ps1 first."
    exit 1
}

Set-Location $BOT_DIR

# ── Load .env ─────────────────────────────────────────────
if (-not (Test-Path ".env")) {
    Write-Host ".env not found in $BOT_DIR — cannot authenticate to API" -ForegroundColor Red
    exit 1
}

$envVars = @{}
Get-Content ".env" | ForEach-Object {
    if ($_ -match '^\s*#') { return }
    if ($_ -match '^\s*$') { return }
    if ($_ -match '^\s*([^=]+?)\s*=\s*(.*?)\s*$') {
        $key = $matches[1]
        $val = $matches[2].Trim('"').Trim("'")
        $envVars[$key] = $val
    }
}

$SECRET = $envVars["DOP_API_WEBHOOK_SECRET"]
if (-not $SECRET) {
    Write-Host "DOP_API_WEBHOOK_SECRET not set in $BOT_DIR\.env" -ForegroundColor Red
    exit 1
}

$envKey = ($envVars["DOP_ENV"] | ForEach-Object { $_.ToUpper().Replace("-", "_") })
if (-not $envKey) { $envKey = "STAGING" }
$envUrlVar = "DOP_API_URL_$envKey"
$API = $envVars[$envUrlVar]
if (-not $API) { $API = $envVars["DOP_API_URL"] }
if (-not $API) { $API = "https://dop-api.pinntag.com" }

$BASE = "$API/api/v1/seeding/bot/source"

Write-Host "──────────────────────────────────────────────"
Write-Host "  PinnTag DOP - manual bot update"
Write-Host "  API: $API"
Write-Host "──────────────────────────────────────────────"

$FILES = @("main.py", "scraper_bulk.py", "auto_setup_cookies.py", "requirements.txt", "version.json")
$headers = @{ "x-bot-secret" = $SECRET }

foreach ($f in $FILES) {
    Write-Host "  Downloading $f"
    try {
        Invoke-WebRequest -Uri "$BASE/file/$f" `
            -Headers $headers `
            -OutFile "$BOT_DIR\$f.new" `
            -UseBasicParsing
    } catch {
        Write-Host "    Failed to fetch $f - aborting (no files overwritten)" -ForegroundColor Red
        Get-ChildItem "$BOT_DIR" -Filter "*.new" | Remove-Item -Force
        exit 1
    }
}

# Commit atomically per file
foreach ($f in $FILES) {
    Move-Item -Force "$BOT_DIR\$f.new" "$BOT_DIR\$f"
}

Write-Host ""
Write-Host "  OK: Source updated" -ForegroundColor Green

# ── Refresh deps ──────────────────────────────────────────
$pip = "$BOT_DIR\venv\Scripts\pip.exe"
if (Test-Path $pip) {
    Write-Host "  Refreshing Python dependencies..."
    & $pip install -q -r "$BOT_DIR\requirements.txt" | Out-Null
}

# ── Restart bot if running ────────────────────────────────
$uvicorn = Get-Process -Name "uvicorn" -ErrorAction SilentlyContinue
if ($uvicorn) {
    Write-Host "  Restarting bot..."
    Stop-Process -Name "uvicorn" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Start-Process -FilePath "$BOT_DIR\venv\Scripts\uvicorn.exe" `
        -ArgumentList "main:app", "--host", "0.0.0.0", "--port", "8000" `
        -WorkingDirectory $BOT_DIR `
        -RedirectStandardOutput "$BOT_DIR\bot.log" `
        -RedirectStandardError "$BOT_DIR\bot.err.log"
    Write-Host "  OK: Bot restarted (log: $BOT_DIR\bot.log)" -ForegroundColor Green
} else {
    Write-Host "  Bot was not running - start it via the desktop shortcut"
}

Write-Host ""
Write-Host "  Done. Current version:"
if (Test-Path "$BOT_DIR\version.json") {
    Get-Content "$BOT_DIR\version.json"
} else {
    Write-Host "  (no version.json)"
}
Write-Host ""
