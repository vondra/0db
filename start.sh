#!/usr/bin/env bash
# start.sh — build the public Quiet Map web app (engine + frontend + server) and serve it.
# The ops compute-release machinery lives in the private repo; here we just build and run.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8520}"

echo "==> engine (source-reader native addon)"
cargo build --release --manifest-path engine/source-reader/Cargo.toml

echo "==> frontend"
(cd frontend && npm ci --no-audit --no-fund && npm run build)

echo "==> server"
(cd server && npm ci --no-audit --no-fund && npm run build)

export FRONTEND_DIST="${FRONTEND_DIST:-$PWD/frontend/dist}"
export PORT
echo "==> serving on :$PORT (Ctrl-C to stop)"
exec node server/dist/server.js
