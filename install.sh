#!/usr/bin/env bash
#
# NEXUS - Tek komutla kurulum (Linux / macOS)
#
#   curl -sSL https://raw.githubusercontent.com/muratdemirci/nexus/main/install.sh | bash
#
# Değişkenler:
#   NEXUS_REPO_URL  git adresi (varsayılan github)
#   NEXUS_DIR       kurulum klasörü (varsayılan ~/nexus)
#   NEXUS_BRANCH    dal (varsayılan main)
#   NEXUS_SERVICE   1 = servis kur (varsayılan), 0 = sadece kur
#
set -e

REPO_URL="${NEXUS_REPO_URL:-https://github.com/muratdemirci/nexus.git}"
INSTALL_DIR="${NEXUS_DIR:-$HOME/nexus}"
BRANCH="${NEXUS_BRANCH:-main}"
AS_SERVICE="${NEXUS_SERVICE:-1}"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m ✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31m ✗\033[0m %s\n' "$*"; }

say "Nexus kurulumu"
echo "    Hedef : $INSTALL_DIR"
echo "    Repo  : $REPO_URL ($BRANCH)"

command -v node >/dev/null 2>&1 || { fail "Node.js bulunamadı. https://nodejs.org  (18+) kurun."; exit 1; }
command -v npm  >/dev/null 2>&1 || { fail "npm bulunamadı."; exit 1; }
command -v git  >/dev/null 2>&1 || { fail "git bulunamadı."; exit 1; }

if [ ! -d "$INSTALL_DIR/.git" ]; then
  say "Repo klonlanıyor..."
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  say "Mevcut repo güncelleniyor..."
  (cd "$INSTALL_DIR" && git pull --ff-only)
fi

say "Bağımlılıklar yükleniyor (npm install)..."
(cd "$INSTALL_DIR" && npm install --no-audit --no-fund)

ok "Kurulum tamam."
echo "    Test     : node \"$INSTALL_DIR/index.js\""
echo "    Tarayıcı : http://localhost:8888"
echo "    Firewall : yönetici olarak: npm run install:service  (ya da ufw kuralları)"

if [ "$AS_SERVICE" = "1" ]; then
  say "Servis olarak kuruluyor (systemd, sudo gerekebilir)..."
  if sudo -n true 2>/dev/null; then
    (cd "$INSTALL_DIR" && sudo node index.js --install || { fail "Servis kurulamadı. Elle: sudo npm run install:service"; })
  else
    fail "sudo şifresiz kullanılamıyor — servis kurulumunu sonra çalıştırın:"
    echo "      (cd \"$INSTALL_DIR\" && sudo npm run install:service)"
  fi
fi
