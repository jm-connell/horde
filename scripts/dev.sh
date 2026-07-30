#!/usr/bin/env bash
# Start Horde backend + frontend for local development.
# Usage: ./start.sh   (or ./scripts/dev.sh)
#
# Set SKIP_WIKI=1 to skip the MkDocs build (Settings → Documentation stays hidden).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DOWNLOADS_DIR="$ROOT/downloads"
export DATA_DIR="$ROOT/data"
mkdir -p "$DOWNLOADS_DIR" "$DATA_DIR"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  if [[ -n "${FRONTEND_PID}" ]]; then kill "${FRONTEND_PID}" 2>/dev/null || true; fi
  if [[ -n "${BACKEND_PID}" ]]; then kill "${BACKEND_PID}" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    echo "On Fedora: sudo dnf install $2" >&2
    exit 1
  fi
}

require_cmd python3 "python3"
require_cmd curl "curl"
require_cmd npm "nodejs npm"

VENV="$ROOT/.venv"
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "Creating Python venv at $VENV ..."
  python3 -m venv "$VENV"
fi
# shellcheck source=/dev/null
source "$VENV/bin/activate"

if [[ ! -f "$VENV/.horde-reqs-stamp" ]] || [[ "$ROOT/backend/requirements.txt" -nt "$VENV/.horde-reqs-stamp" ]]; then
  echo "Installing backend dependencies ..."
  pip install -r "$ROOT/backend/requirements.txt"
  touch "$VENV/.horde-reqs-stamp"
fi

if [[ ! -f "$VENV/.horde-dev-reqs-stamp" ]] || [[ "$ROOT/backend/requirements-dev.txt" -nt "$VENV/.horde-dev-reqs-stamp" ]]; then
  echo "Installing backend dev dependencies (pytest, mkdocs-material) ..."
  pip install -r "$ROOT/backend/requirements-dev.txt"
  touch "$VENV/.horde-dev-reqs-stamp"
fi

wiki_needs_build() {
  local wiki_index="$ROOT/backend/static/wiki/index.html"
  local stamp="$VENV/.horde-wiki-stamp"
  if [[ ! -f "$wiki_index" ]]; then
    return 0
  fi
  if [[ ! -f "$stamp" ]]; then
    return 0
  fi
  if [[ "$ROOT/mkdocs.yml" -nt "$stamp" ]]; then
    return 0
  fi
  if find "$ROOT/docs" -type f -newer "$stamp" -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

if [[ "${SKIP_WIKI:-}" == "1" ]]; then
  echo "SKIP_WIKI=1 — not building wiki (wiki_available will stay false until you build)."
elif wiki_needs_build; then
  echo "Building MkDocs wiki into backend/static/wiki ..."
  (cd "$ROOT" && mkdocs build -d backend/static/wiki --strict)
  touch "$VENV/.horde-wiki-stamp"
  echo "Wiki ready at /wiki/ (via Vite proxy or http://127.0.0.1:8080/wiki/)."
else
  echo "Wiki already up to date at backend/static/wiki."
fi

if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
  echo "Installing frontend dependencies ..."
  (cd "$ROOT/frontend" && npm install)
fi

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
  python -m uvicorn app.main:app --reload --port 8080
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
