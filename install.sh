#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [ ! -f "dist/cli.js" ]; then
  if [ -f "package-lock.json" ]; then
    npm ci --ignore-scripts
  else
    npm install --ignore-scripts
  fi
  npm run build
fi

exec node "$HERE/bin/auto-work.mjs" install "$@"
