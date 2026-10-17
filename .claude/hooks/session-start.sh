#!/bin/bash
# Install backend and frontend dependencies in Claude Code cloud sessions so
# ruff, mypy, pytest, eslint, tsc, vitest and Playwright work from the start.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
export PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1

# Backend: the hash-locked runtime set, then the dev tools. --ignore-installed
# because the image's Debian PyYAML has no RECORD file and pip cannot replace it.
python3 -m pip install -q --ignore-installed -r backend/requirements.lock
python3 -m pip install -q -r backend/requirements-dev.txt

# Frontend (npm install, not ci, so the cached container's node_modules is reused).
(cd frontend && npm install --no-audit --no-fund --loglevel=error)

# Playwright: use the preinstalled Chromium (the bundled build may differ).
chromium="$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1 || true)"
if [ -n "$chromium" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PW_CHROMIUM_EXECUTABLE=\"$chromium\"" >> "$CLAUDE_ENV_FILE"
fi
