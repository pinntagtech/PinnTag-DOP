# PinnTag DOP Bot - Windows Installer
#
# All bot files are now served through the authenticated DOP API.
# Operator needs the x-bot-secret from the DOP admin before installing.
#
# Usage:
#   $env:DOP_BOT_SECRET = "<secret>"
#   irm <install-host>/install.ps1 | iex

$ErrorActionPreference = "Stop"
$BOT_DIR = "$env:USERPROFILE\pinntag-dop-bot"
$DOP_API_URL = if ($env:DOP_API_URL) { $env:DOP_API_URL } else { "https://dop-api.pinntag.com" }
$DOP_BOT_SECRET = if ($env:DOP_BOT_SECRET) { $env:DOP_BOT_SECRET } else { $env:DOP_API_WEBHOOK_SECRET }
$API_BASE = "$DOP_API_URL/api/v1/seeding/bot/source"

function Write-Step($n, $total, $msg) {
    Write-Host "[$n/$total] $msg" -ForegroundColor Cyan
}
function Write-Ok($msg) { Write-Host "  OK: $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  WARNING: $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  ERROR: $msg" -ForegroundColor Red }

if (-not $DOP_BOT_SECRET) {
    Write-Fail "DOP_BOT_SECRET is required."
    Write-Host "Get it from your DOP admin, then:"
    Write-Host '  $env:DOP_BOT_SECRET = "<secret>"'
    Write-Host "  irm <install-host>/install.ps1 | iex"
    exit 1
}

$headers = @{ "x-bot-secret" = $DOP_BOT_SECRET }

function Api-Download($name, $dest) {
    Invoke-WebRequest -Uri "$API_BASE/file/$name" `
        -Headers $headers `
        -OutFile $dest `
        -UseBasicParsing
}

Clear-Host
Write-Host ""
Write-Host "==================================================" -ForegroundColor White
Write-Host "  PinnTag DOP - Bot Setup" -ForegroundColor White
Write-Host "==================================================" -ForegroundColor White
Write-Host ""
Write-Host "  Installing the PinnTag DOP bot."
Write-Host "  API: $DOP_API_URL"
Write-Host ""

# ── Step 1: Python ────────────────────────────────────────
Write-Step 1 6 "Checking Python..."
$pythonOk = $false
try { $v = python --version 2>&1; Write-Ok $v; $pythonOk = $true } catch { }

if (-not $pythonOk) {
    Write-Host "  Python not found. Downloading installer..." -ForegroundColor Yellow
    $pyInstaller = "$env:TEMP\python_installer.exe"
    $pyUrl = "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe"
    Write-Host "  Downloading Python 3.12..." -NoNewline
    try {
        Invoke-WebRequest -Uri $pyUrl -OutFile $pyInstaller -UseBasicParsing
        Write-Host " Done" -ForegroundColor Green
    } catch {
        Write-Fail "Download failed. Install Python from python.org"
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "  Installing Python (silent)..."
    $args = "/quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=0"
    Start-Process -FilePath $pyInstaller -ArgumentList $args -Wait -NoNewWindow
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    try {
        $v = python --version 2>&1
        Write-Ok "Python installed: $v"
    } catch {
        Write-Warn "Python installed but PATH not updated yet"
        Write-Host "  Please restart this installer"
        Read-Host "Press Enter to exit"
        exit 1
    }
}

$pyVer = python --version 2>&1
$verMatch = [regex]::Match($pyVer, '(\d+)\.(\d+)')
if ($verMatch.Success) {
    $minor = [int]$verMatch.Groups[2].Value
    if ($minor -ge 14) {
        Write-Warn "Python $pyVer detected - may have compatibility issues"
        Write-Host "  Recommended: Python 3.12. Continuing anyway..."
    }
}

Write-Step 2 6 "Checking system dependencies..."
Write-Ok "Windows - no extra dependencies needed"

# ── Step 3: Download bot files from API ──────────────────
Write-Step 3 6 "Downloading bot files from API..."
New-Item -ItemType Directory -Force -Path $BOT_DIR | Out-Null

$files = @("main.py", "scraper_bulk.py", "auto_setup_cookies.py", "requirements.txt", "version.json")
foreach ($file in $files) {
    Write-Host "  Downloading $file"
    try {
        Api-Download $file "$BOT_DIR\$file"
    } catch {
        Write-Fail "Failed to download $file"
        Write-Host "    $_"
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# Write .env if not already present
$envPath = "$BOT_DIR\.env"
if (-not (Test-Path $envPath)) {
@"
# PinnTag DOP Bot Configuration
DOP_API_URL_DEV=http://localhost:3000
DOP_API_URL_PRE_PROD=https://dop-api.pinntag.com
DOP_API_URL_STAGING=https://dop-api.pinntag.com
DOP_API_URL_PRODUCTION=https://dop-api.pinntag.com

DOP_ENV=staging

DOP_API_WEBHOOK_SECRET=$DOP_BOT_SECRET

GOOGLE_COOKIES_PATH=./google_cookies.json
MAX_REVIEWS=100
MAX_GALLERY_PER_FOLDER=50
HEADLESS=false
LOG_LEVEL=INFO
"@ | Out-File -FilePath $envPath -Encoding ASCII
    Write-Ok "Wrote $envPath"
} else {
    Write-Warn "Keeping existing .env"
}

Write-Ok "Bot files downloaded to $BOT_DIR"

# ── Step 4: Python venv + dependencies ───────────────────
Write-Step 4 6 "Installing Python dependencies..."
Set-Location $BOT_DIR
python -m venv venv | Out-Null
& ".\venv\Scripts\python.exe" -m pip install -q -r requirements.txt
Write-Ok "Dependencies installed"

# ── Step 5: Playwright Chromium ──────────────────────────
Write-Step 5 6 "Installing Chromium browser..."
$playwrightDir = "$env:LOCALAPPDATA\ms-playwright"
if (-not (Test-Path $playwrightDir)) {
    Write-Host "  Installing Chromium (first time only)..." -NoNewline
    & ".\venv\Scripts\playwright.exe" install chromium | Out-Null
    Write-Host " Done" -ForegroundColor Green
} else {
    Write-Ok "Chromium already installed"
}

# ── Step 6: Google login ──────────────────────────────────
Write-Step 6 6 "Setting up Google session..."
$cookiesPath = "$BOT_DIR\google_cookies.json"
if (-not (Test-Path $cookiesPath)) {
    Write-Host "  A browser window will open for Google login..."
    & ".\venv\Scripts\python.exe" auto_setup_cookies.py
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Google session saved"
    } else {
        Write-Warn "Google login skipped - reviews will be disabled"
    }
} else {
    Write-Ok "Google session already set up"
}

# ── Create start script + desktop shortcut ────────────────
$startScript = "$BOT_DIR\start.bat"
@"
@echo off
cd /d "$BOT_DIR"
call venv\Scripts\activate.bat

python -c "import fastapi" 2>nul
if %errorlevel% neq 0 (
    echo   Installing missing dependencies...
    pip install -q -r requirements.txt
)

start "" "https://dop.pinntag.com"
echo.
echo   PinnTag DOP Bot is running...
echo   Press Ctrl+C to stop
echo.
uvicorn main:app --host 0.0.0.0 --port 8000
pause
"@ | Out-File -FilePath $startScript -Encoding ASCII

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\PinnTag DOP Bot.lnk")
$Shortcut.TargetPath = "cmd.exe"
$Shortcut.Arguments = "/k `"$startScript`""
$Shortcut.WorkingDirectory = $BOT_DIR
$Shortcut.Description = "PinnTag DOP Bot"
$Shortcut.Save()

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Manual update one-liner:"
Write-Host "    `$env:SECRET=`"<your secret>`"; irm -Headers @{`"x-bot-secret`"=`$env:SECRET} ``"
Write-Host "      $API_BASE/file/update.ps1 | iex"
Write-Host ""
Write-Host "  Self-update also runs automatically on every bot start."
Write-Host ""
Write-Host "  Starting bot now..."
Write-Host "  Portal opening at https://dop.pinntag.com"
Write-Host ""

Start-Process "https://dop.pinntag.com"
Set-Location $BOT_DIR
& ".\venv\Scripts\activate.bat"
uvicorn main:app --host 0.0.0.0 --port 8000
