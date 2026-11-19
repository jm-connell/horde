#!/usr/bin/env bash
# Run the Playwright suite as parallel shards in this one checkout.
#
#   scripts/e2e-shards.sh              4 shards
#   E2E_SHARDS=6 scripts/e2e-shards.sh
#   scripts/e2e-shards.sh e2e/watch.spec.ts   (extra args go to playwright)
#
# The suite is serial within a run (one seeded server, reset between tests),
# so shards are separate runs: each gets its own app/setup ports, and with
# them its own server data (e2e/.runtime/<mode>-<port>) and saved sign-ins
# (frontend/e2e/.auth/<port>). Build the SPA first (npm run build).
#
#   E2E_SHARDS      number of shards (default 4)
#   E2E_PORT_BASE   first app port (default 8091); shard i uses
#                   base + 2(i-1) for the app and the next port for setup
#   E2E_PYTHON, PW_CHROMIUM_EXECUTABLE   as for `npx playwright test`
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARDS="${E2E_SHARDS:-4}"
BASE="${E2E_PORT_BASE:-8091}"
OUT="$ROOT/frontend/test-results"
mkdir -p "$OUT"

pids=()
for ((i = 1; i <= SHARDS; i++)); do
  app=$((BASE + 2 * (i - 1)))
  (
    cd "$ROOT/frontend" &&
      E2E_APP_PORT=$app E2E_SETUP_PORT=$((app + 1)) \
        npx playwright test --shard="$i/$SHARDS" --output="$OUT/shard-$i" \
        --reporter=line "$@" >"$OUT/shard-$i.log" 2>&1
  ) &
  pids+=($!)
done

status=0
for ((i = 1; i <= SHARDS; i++)); do
  if wait "${pids[$((i - 1))]}"; then
    result="ok"
  else
    result="FAILED"
    status=1
  fi
  echo "==> shard $i/$SHARDS: $result (log: frontend/test-results/shard-$i.log)"
  # Playwright's closing summary: the counts and the tests that failed.
  tail -n 60 "$OUT/shard-$i.log" |
    grep -E '^\s+([0-9]+ (passed|failed|flaky|skipped)|\[[a-z]+\] ›)' || true
done
exit "$status"
