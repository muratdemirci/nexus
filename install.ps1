#Requires -Version 5.1
<#
  NEXUS - Tek komutla kurulum (Windows PowerShell)

  Invoke-Expression (Invoke-RestMethod https://raw.githubusercontent.com/muratdemirci/nexus/main/install.ps1)

  Parametreler:
    -Dir        kurulum klasoru (varsayilan ~\nexus)
    -Repo       git adresi
    -Branch     dal (main)
    -NoService  baslangic kisa yolu ekleme
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

Say "Nexus kurulumu"
Write-Host "    Hedef : $Dir"
Write-Host "    Repo  : $Repo ($Branch)"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js bulunamadi. https://nodejs.org (18+) kurun."; exit 1 }
if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { Fail "npm bulunamadi."; exit 1 }
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { Fail "git bulunamadi."; exit 1 }

if (-not (Test-Path "$Dir\.git")) {
  Say "Repo klonlaniyor..."
  git clone --branch $Branch --depth 1 $Repo $Dir
} else {
  Say "Mevcut repo guncelleniyor..."
  Push-Location $Dir
  git pull --ff-only
  Pop-Location
}

Say "Bagi mliliklar yukleniyor (npm install)..."
Push-Location $Dir
npm install --no-audit --no-fund
Pop-Location

Ok "Kurulum tamam."
Write-Host "    Test     : node `"$Dir\index.js`""
Write-Host "    Tarayici : http://localhost:8888"
Write-Host "    Guvenlik duvari (Windows): netsh advfirewall firewall add rule name=`"Nexus Hub 8888`" dir=in action=allow protocol=TCP localport=8888"
Write-Host "    Keşif: netsh advfirewall firewall add rule name=`"Nexus Discovery 8889`" dir=in action=allow protocol=UDP localport=8889"

if (-not $NoService) {
  Say "Baslangic klasorune kisa yol ekleniyor (yeniden oturum acinca calisir)..."
  node "$Dir\index.js" --install
}
