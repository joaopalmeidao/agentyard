#!/usr/bin/env bash
# Grava o roteiro de test/suite.js num VS Code real e gera docs/video/worktree-graph.mp4 (+ .gif).
# Uma janela do VS Code abre por ~50 s durante a gravação.
set -e
cd "$(dirname "$0")/.."
REC=docs/.tmp/rec
rm -rf "$REC" && mkdir -p "$REC"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/record-vscode.ps1 -Dir "$(pwd -W)/$REC" &
WTGRAPH_VIDEO="$(pwd -W)/$REC" node test/run.js
wait
node scripts/build-video.js
ls -la docs/video
