$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "dist/cli.js")) {
  if (Test-Path "package-lock.json") {
    npm ci --ignore-scripts
  } else {
    npm install --ignore-scripts
  }
  npm run build
}

node "$PSScriptRoot/bin/auto-work.mjs" install @args
