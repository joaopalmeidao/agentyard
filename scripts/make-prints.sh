#!/usr/bin/env bash
# Gera docs/prints/*.png: cria o repositório demo, extrai o estado real e renderiza o painel num Edge headless.
set -e
cd "$(dirname "$0")/.."
EDGE="${EDGE:-/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe}"
DEMO=docs/.tmp/demo; OUT=docs/prints; mkdir -p "$OUT"
HARNESS="file:///$(cd scripts && pwd -W)/print-harness.html"

shot() { # shot <arquivo> <cena> <largura> <altura>
  "$EDGE" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size="$3,$4" \
    --virtual-time-budget=3000 --screenshot="$(pwd -W)/$OUT/$1" "$HARNESS#$2" >/dev/null 2>&1
  echo "  $OUT/$1"
}
state() { { printf 'window.__STATE = '; node scripts/dump-state.js "$DEMO/loja-app" "$@"; printf ';\n'; } > docs/.tmp/state.js; }

bash scripts/make-demo.sh >/dev/null 2>&1
state "" off
shot 01-painel.png painel 1440 780
shot 02-menu-branch.png menu 1440 700
shot 03-arrastar-para-mesclar.png drag 1440 560
shot 06-menu-commit.png menu-commit 1440 760

node scripts/test-sync.js "$DEMO/loja-app" "" docs/.tmp/status.json >/dev/null
state docs/.tmp/status.json sync-on
shot 05-depois-do-sync.png painel 1440 780
