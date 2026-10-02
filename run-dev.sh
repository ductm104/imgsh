#!/usr/bin/env bash
# Dev with frontend hot reload:
#  - Bun serves dist/ on :1420 with live-reload (scripts/dev-server.ts)
#  - Tauri loads that URL (devUrl override), Rust code still hot-reloads via `tauri dev`
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-1420}"
DEV_URL="http://127.0.0.1:${PORT}"

bun scripts/dev-server.ts &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  if curl -sf -o /dev/null "$DEV_URL/" 2>/dev/null; then break; fi
  sleep 0.2
done
curl -sf -o /dev/null "$DEV_URL/" || { echo "dev server failed to start on $DEV_URL" >&2; exit 1; }
echo "frontend: $DEV_URL (live-reload on dist/* changes)"

bunx tauri dev -c "{\"build\":{\"devUrl\":\"$DEV_URL\"}}"
