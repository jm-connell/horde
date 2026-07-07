#!/usr/bin/env bash
# Start Horde backend + frontend for local development.
# Usage: ./scripts/dev.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DOWNLOADS_DIR="$ROOT/downloads"
export DATA_DIR="$ROOT/data"
mkdir -p "$DOWNLOADS_DIR" "$DATA_DIR"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  if [[ -n "$FRONTEND_PID" ]]; then kill "$FRONTEND_PID" 2>/dev/null || true; fi
  if [[ -n "$BACKEND_PID" ]]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

wait_for_backend() {
  local url="http://127.0.0.1:8080/api/health"
  for _ in $(seq 1 60); do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Backend did not become ready at $url" >&2
  exit 1
}

echo "Starting backend on http://127.0.0.1:8080 ..."
(
  cd "$ROOT/backend"
  uvicorn app.main:app --reload --port 8080
) &
BACKEND_PID=$!

wait_for_backend
echo "Backend ready."

echo "Starting frontend (Vite dev server) ..."
(
  cd "$ROOT/frontend"
  npm run dev
) &
FRONTEND_PID=$!

echo ""
echo "Horde is running. Open the Vite URL shown above (usually http://localhost:5173)."
echo "Press Ctrl+C to stop both servers."
echo ""

wait "$FRONTEND_PID"
