#!/usr/bin/env bash
# Regera media/logo.png (ícone do Marketplace) e docs/social-preview.png (prévia do GitHub).
set -e
cd "$(dirname "$0")/.."
EDGE="${EDGE:-/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe}"
"$EDGE" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 --window-size=256,256 \
  --screenshot="$(pwd -W)/media/logo.png" "file:///$(pwd -W)/scripts/logo.html?s=256#b" >/dev/null 2>&1
"$EDGE" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,640 --virtual-time-budget=4000 \
  --screenshot="$(pwd -W)/docs/social-preview.png" "file:///$(pwd -W)/scripts/social.html" >/dev/null 2>&1
echo "media/logo.png e docs/social-preview.png atualizados"
