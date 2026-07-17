#!/usr/bin/env bash
# Pull latest Horde, rebuild the Docker image with the commit SHA, and restart.
# Run on the TrueNAS / Docker host (not inside the container Bash button).
#
# Usage (from your Dockge stack folder):
#   bash update.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but was not found." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but was not found. Run this on the host, not inside the Horde container." >&2
  exit 1
fi

echo "Pulling latest code..."
git pull

SHA="$(git rev-parse HEAD)"
echo "Building horde image at ${SHA:0:7}..."
# Pass SHA on the same line as sudo so it is not stripped from the environment.
sudo HORDE_GIT_SHA="$SHA" docker compose build horde

echo "Recreating containers..."
sudo HORDE_GIT_SHA="$SHA" docker compose up -d

echo
echo "Updated to ${SHA:0:7}."
echo "Hard-refresh the browser (Ctrl+Shift+R) if the UI looks stale."
echo "Library data on host volumes is unchanged."
