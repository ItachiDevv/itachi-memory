#!/bin/bash
# Itachi Memory System — Zero-prerequisite installer for Mac/Linux
# Usage: bash bootstrap.sh
#   or:  bash bootstrap.sh --uninstall [--force]
#   or:  curl -fsSL https://raw.githubusercontent.com/ItachiDevv/itachi-memory/master/bootstrap.sh | bash
set -e

echo ""
echo "  Itachi Memory System — Bootstrap"
echo ""

# 1. Install Node.js if missing
if ! command -v node >/dev/null 2>&1; then
  echo "  Installing Node.js..."
  if [ "$(uname)" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install node
    else
      echo "  Install Homebrew first: https://brew.sh" && exit 1
    fi
  else
    if command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y nodejs
    else
      echo "  Install Node.js manually: https://nodejs.org" && exit 1
    fi
  fi
fi

# 2. Install Git if missing
if ! command -v git >/dev/null 2>&1; then
  echo "  Installing Git..."
  if [ "$(uname)" = "Darwin" ]; then
    xcode-select --install 2>/dev/null || brew install git
  else
    sudo apt-get install -y git 2>/dev/null || sudo dnf install -y git
  fi
fi

# 3. Clone repo if not already in it
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
if [ ! -f "$SCRIPT_DIR/install.mjs" ]; then
  CLONE_DIR="$HOME/itachi-memory"
  if [ ! -d "$CLONE_DIR" ]; then
    echo "  Cloning itachi-memory..."
    git clone https://github.com/ItachiDevv/itachi-memory.git "$CLONE_DIR"
  fi
  cd "$CLONE_DIR"
else
  cd "$SCRIPT_DIR"
fi

# 4. Run the real installer
node install.mjs "$@"
