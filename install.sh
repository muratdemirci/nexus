#!/usr/bin/env bash
#
# NEXUS - One-command installer (Linux / macOS)
#
#   curl -sSL https://raw.githubusercontent.com/muratdemirci/nexus/main/install.sh | bash
#
# Variables:
#   NEXUS_REPO_URL  git repo URL (default github)
#   NEXUS_DIR       install directory (default ~/nexus)
#   NEXUS_BRANCH    git branch (default main)
#   NEXUS_SERVICE   1 = install as service (default), 0 = install only
#
set -e

REPO_URL="${NEXUS_REPO_URL:-https://github.com/muratdemirci/nexus.git}"
INSTALL_DIR="${NEXUS_DIR:-$HOME/nexus}"
BRANCH="${NEXUS_BRANCH:-main}"
AS_SERVICE="${NEXUS_SERVICE:-1}"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m ✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31m ✗\033[0m %s\n' "$*"; }

say "Nexus installer"
echo "    Target : $INSTALL_DIR"
echo "    Repo   : $REPO_URL ($BRANCH)"

command -v node >/dev/null 2>&1 || { fail "Node.js not found. Install from https://nodejs.org (18+)."; exit 1; }
command -v npm  >/dev/null 2>&1 || { fail "npm not found."; exit 1; }
command -v git  >/dev/null 2>&1 || { fail "git not found."; exit 1; }

if [ ! -d "$INSTALL_DIR/.git" ]; then
  say "Cloning repository..."
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  say "Updating existing repository..."
  (cd "$INSTALL_DIR" && git pull --ff-only)
fi

say "Installing dependencies (npm install)..."
(cd "$INSTALL_DIR" && npm install --no-audit --no-fund)

ok "Installation complete."
echo "    Test     : node \"$INSTALL_DIR/index.js\""
echo "    Browser  : http://localhost:8888"
echo "    Firewall : as admin run: npm run install:service  (or ufw rules)"

if [ "$AS_SERVICE" = "1" ]; then
  say "Installing as a service (systemd, may need sudo)..."
  if sudo -n true 2>/dev/null; then
    (cd "$INSTALL_DIR" && sudo node index.js --install || { fail "Service install failed. Run manually: sudo npm run install:service"; })
  else
    fail "sudo without password unavailable — run the service install later:"
    echo "      (cd \"$INSTALL_DIR\" && sudo npm run install:service)"
  fi
fi
