#!/usr/bin/env bash
# Start Horde for local development on Linux (Fedora).
# Usage: ./start.sh
exec "$(cd "$(dirname "$0")" && pwd)/scripts/dev.sh" "$@"
