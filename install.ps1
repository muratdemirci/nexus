#Requires -Version 5.1
<#
  NEXUS - One-command installer (Windows PowerShell)

  Invoke-Expression (Invoke-RestMethod https://raw.githubusercontent.com/muratdemirci/nexus/main/install.ps1)

  Parameters:
    -Dir        install folder (default ~\nexus)
    -Repo       git repo URL
    -Branch     branch (main)
    -NoService  skip Startup shortcut
#>
param(
  [string]$Dir = "$env:USERPROFILE\nexus",
  [string]$Repo = "https://github.com/muratdemirci/nexus.git",
  [string]$Branch = "main",
  [switch]$NoService
)
$ErrorActionPreference = "Stop"

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "  ok: $m" -ForegroundColor Green }
function Fail($m){ Write-Host "  x: $m" -ForegroundColor Red }

Say "Nexus installer"
Write-Host "    Target : $Dir"
Write-Host "    Repo   : $Repo ($Branch)"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js not found. Install from https://nodejs.org (18+)."; exit 1 }
if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { Fail "npm not found."; exit 1 }
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { Fail "git not found."; exit 1 }

if (-not (Test-Path "$Dir\.git")) {
  Say "Cloning repository..."
  git clone --branch $Branch --depth 1 $Repo $Dir
} else {
  Say "Updating existing repository..."
  Push-Location $Dir
  git pull --ff-only
  Pop-Location
}

Say "Installing dependencies (npm install)..."
Push-Location $Dir
npm install --no-audit --no-fund
Pop-Location

Ok "Installation complete."
Write-Host "    Test     : node `"$Dir\index.js`""
Write-Host "    Browser  : http://localhost:8888"
Write-Host "    Firewall (Windows): netsh advfirewall firewall add rule name=`"Nexus Hub 8888`" dir=in action=allow protocol=TCP localport=8888"
Write-Host "    Discovery: netsh advfirewall firewall add rule name=`"Nexus Discovery 8889`" dir=in action=allow protocol=UDP localport=8889"

if (-not $NoService) {
  Say "Adding Startup shortcut (runs at next login)..."
  node "$Dir\index.js" --install
}
