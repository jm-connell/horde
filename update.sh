#!/usr/bin/env bash
# Pull latest Horde, rebuild the Docker image with the commit SHA, and restart.
# Run on the TrueNAS / Docker host (not inside the container Bash button).
#
# Usage (from your Dockge stack folder):
#   bash update.sh
#
# Optional env:
#   HORDE_HEALTH_URL          Health endpoint to poll (default http://127.0.0.1:8686/api/health)
#   HORDE_COMPOSE_PROFILES    Compose profiles (e.g. ai); also honors COMPOSE_PROFILES
#   HORDE_HEALTH_TIMEOUT_SEC  Seconds to wait for health (default 90)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

HEALTH_URL="${HORDE_HEALTH_URL:-http://127.0.0.1:8686/api/health}"
HEALTH_TIMEOUT_SEC="${HORDE_HEALTH_TIMEOUT_SEC:-90}"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but was not found." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but was not found. Run this on the host, not inside the Horde container." >&2
  exit 1
fi

compose() {
  # Pass HORDE_GIT_SHA on the same line as sudo so it is not stripped from the environment.
  sudo HORDE_GIT_SHA="$SHA" docker compose "$@"
}

want_ai_profile() {
  local profiles="${HORDE_COMPOSE_PROFILES:-${COMPOSE_PROFILES:-}}"
  if [[ ",${profiles}," == *",ai,"* ]] || [[ "${profiles}" == "ai" ]]; then
    return 0
  fi
  # Reuse AI profile if the optional Ollama service is already running.
  if sudo docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'horde-ollama'; then
    return 0
  fi
  return 1
}

print_health_summary() {
  local json="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json, sys
data = json.load(sys.stdin)
pot = data.get("pot_provider") or {}
ollama = data.get("ollama") or {}
print("Health summary:")
print("  status:            {}".format(data.get("status", "?")))
print("  horde_version:     {} ({})".format(data.get("horde_version", "?"), data.get("horde_sha", "?")))
print("  yt_dlp_version:    {}".format(data.get("yt_dlp_version", "?")))
print("  pot_provider:      {}".format(pot.get("status", "n/a")))
print("  wiki_available:    {}".format(data.get("wiki_available", "?")))
if ollama:
    print("  ollama.reachable:  {}".format(ollama.get("reachable", "?")))
print("  library_videos:    {}".format(data.get("library_video_count", "?")))
' <<<"$json"
  else
    echo "Health OK (install python3 on the host for a field summary)."
    echo "$json"
  fi
}

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SEC))
  local body=""
  echo "Waiting for ${HEALTH_URL} (up to ${HEALTH_TIMEOUT_SEC}s) ..."
  while (( SECONDS < deadline )); do
    if body="$(curl -sf "$HEALTH_URL" 2>/dev/null)"; then
      if command -v python3 >/dev/null 2>&1; then
        if python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("status")=="ok" else 1)' <<<"$body"; then
          print_health_summary "$body"
          return 0
        fi
      else
        case "$body" in
          *'"status":"ok"'*|*'\"status\": \"ok\"'*)
            print_health_summary "$body"
            return 0
            ;;
        esac
      fi
    fi
    sleep 2
  done
  echo "Horde did not become healthy at ${HEALTH_URL} within ${HEALTH_TIMEOUT_SEC}s." >&2
  echo "Check logs: sudo docker compose logs --tail=80 horde" >&2
  exit 1
}

echo "Pulling latest code..."
git pull

SHA="$(git rev-parse HEAD)"
echo "Building horde image at ${SHA:0:7}..."
compose build horde

UP_ARGS=(up -d)
if want_ai_profile; then
  echo "Including Compose profile: ai"
  UP_ARGS=(--profile ai up -d)
fi

echo "Recreating containers..."
compose "${UP_ARGS[@]}"

if ! command -v curl >/dev/null 2>&1; then
  echo
  echo "Updated to ${SHA:0:7}."
  echo "curl not found; skipped health wait. Open http://<server-ip>:8686 and hard-refresh (Ctrl+Shift+R)."
  echo "Library data on host volumes is unchanged."
  exit 0
fi

echo
wait_for_health

echo
echo "Updated to ${SHA:0:7}."
echo "Hard-refresh the browser (Ctrl+Shift+R) if the UI looks stale."
echo "Library data on host volumes is unchanged."
echo "If downloads fail after YouTube changes, see Maintenance → Bumping yt-dlp (/wiki/ops/maintenance/)."
