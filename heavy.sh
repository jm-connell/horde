#!/bin/bash
# Run a heavy command (full pytest, check.sh, full Playwright) holding one of two shared slots.
# Usage: $SP/heavy.sh <command...>
SP=/tmp/claude-0/-home-user-horde/d3776dd8-d2e0-55bb-8adf-2714698fd5e2/scratchpad
while true; do
  for s in 1 2; do
    exec {fd}>"$SP/heavy.slot$s"
    if flock -n "$fd"; then
      "$@"; rc=$?
      flock -u "$fd"; exec {fd}>&-
      exit $rc
    fi
    exec {fd}>&-
  done
  sleep 10
done
