#!/usr/bin/env bash
# Run every quality gate locally, in the same order CI does.
#
#   scripts/check.sh           backend + frontend + docs gates
#   scripts/check.sh --e2e     ...plus the Playwright browser suite
#
# Environment:
#   PYTHON                   interpreter with backend/requirements*.txt installed
#                            (default: python3, or .venv/bin/python when present)
#   PW_CHROMIUM_EXECUTABLE   Chromium binary for Playwright when the preinstalled
#                            browser does not match the pinned Playwright version
#   E2E_APP_PORT/E2E_SETUP_PORT   Playwright web-server ports (default 8091/8092)
#
# Every gate runs even if an earlier one fails; the exit status is non-zero if
# any gate failed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_E2E=0
for arg in "$@"; do
  case "$arg" in
    --e2e) RUN_E2E=1 ;;
    -h | --help)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${PYTHON:-}" ]]; then
  if [[ -x "$ROOT/.venv/bin/python" ]]; then
    PYTHON="$ROOT/.venv/bin/python"
  else
    PYTHON=python3
  fi
fi

failed=()
passed=()

gate() {
  local name="$1"
  shift
  echo
  echo "==> $name"
  if "$@"; then
    passed+=("$name")
  else
    failed+=("$name")
  fi
}

in_dir() {
  local dir="$1"
  shift
  (cd "$dir" && "$@")
}

# --- backend -----------------------------------------------------------------
gate "ruff check" in_dir "$ROOT/backend" "$PYTHON" -m ruff check .
gate "ruff format --check" in_dir "$ROOT/backend" "$PYTHON" -m ruff format --check .
gate "mypy" in_dir "$ROOT/backend" "$PYTHON" -m mypy
gate "requirements.lock up to date" "$PYTHON" "$ROOT/scripts/check_requirements_lock.py"
gate "openapi.json up to date" in_dir "$ROOT/backend" env PYTHONPATH=. "$PYTHON" -m app.export_openapi --check openapi.json
gate "pytest" in_dir "$ROOT/backend" env PYTHONPATH=. "$PYTHON" -m pytest -q

# --- frontend ----------------------------------------------------------------
if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
  echo "frontend/node_modules missing; run 'npm ci' in frontend/ first" >&2
  failed+=("npm ci (not run)")
else
  gate "api types up to date" in_dir "$ROOT/frontend" npm run --silent gen:api:check
  gate "eslint" in_dir "$ROOT/frontend" npm run --silent lint
  gate "prettier --check" in_dir "$ROOT/frontend" npm run --silent format:check
  gate "tsc" in_dir "$ROOT/frontend" npm run --silent typecheck
  gate "vitest" in_dir "$ROOT/frontend" npm test --silent
  gate "vite build" in_dir "$ROOT/frontend" npm run --silent build
fi

# --- docs --------------------------------------------------------------------
if "$PYTHON" -c "import mkdocs" 2>/dev/null; then
  gate "mkdocs build --strict" in_dir "$ROOT" "$PYTHON" -m mkdocs build --strict --site-dir "$(mktemp -d)"
else
  echo
  echo "==> mkdocs build --strict (skipped: mkdocs not installed in $PYTHON)"
fi

# --- browser suite (opt-in) --------------------------------------------------
if [[ "$RUN_E2E" == 1 ]]; then
  gate "playwright" in_dir "$ROOT/frontend" env E2E_PYTHON="$PYTHON" npx playwright test
fi

echo
echo "passed: ${#passed[@]}  failed: ${#failed[@]}"
if ((${#failed[@]} > 0)); then
  printf 'FAILED: %s\n' "${failed[@]}"
  exit 1
fi
echo "all gates passed"
