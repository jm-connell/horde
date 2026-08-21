#!/usr/bin/env bash
# Pull latest Horde, rebuild the Docker image with the commit SHA, and restart.
# Run on the TrueNAS / Docker host (not inside the container Bash button).
#
# Usage (from your Dockge stack folder):
#   bash update.sh
#
# Optional env:
#   HORDE_HEALTH_URL            Health endpoint to poll (default http://127.0.0.1:8686/api/health)
#   HORDE_COMPOSE_PROFILES      Compose profiles (e.g. ai); also honors COMPOSE_PROFILES
#   HORDE_HEALTH_TIMEOUT_SEC    Seconds to wait for health (default 90)
#   HORDE_FORCE_VOLUME_CHANGE=1 Allow recreate even if DOWNLOADS_PATH / DATA_PATH would move
#
# Host paths and settings live on bind-mounted volumes. This script snapshots the
# running container's mounts into .env *before* git pull so a compose-file refresh
# cannot point Horde at empty default directories.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -f "$ROOT/scripts/update_lib.sh" ]]; then
  echo "scripts/update_lib.sh is missing. Run update.sh from a full Horde git checkout." >&2
  exit 1
fi
# shellcheck source=scripts/update_lib.sh
source "$ROOT/scripts/update_lib.sh"

HEALTH_URL="${HORDE_HEALTH_URL:-http://127.0.0.1:8686/api/health}"
HEALTH_TIMEOUT_SEC="${HORDE_HEALTH_TIMEOUT_SEC:-90}"
ENV_FILE="$ROOT/.env"
SHA=""

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but was not found." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but was not found. Run this on the host, not inside the Horde container." >&2
  exit 1
fi

USE_SUDO=1
if docker info >/dev/null 2>&1; then
  USE_SUDO=0
fi

docker_bin() {
  if [[ "$USE_SUDO" -eq 0 ]]; then
    docker "$@"
  else
    sudo docker "$@"
  fi
}

compose() {
  # Pass HORDE_GIT_SHA on the same line as sudo so it is not stripped from the environment.
  if [[ "$USE_SUDO" -eq 0 ]]; then
    HORDE_GIT_SHA="${SHA:-unknown}" docker compose "$@"
  else
    sudo HORDE_GIT_SHA="${SHA:-unknown}" docker compose "$@"
  fi
}

want_ai_profile() {
  local profiles="${HORDE_COMPOSE_PROFILES:-${COMPOSE_PROFILES:-}}"
  if [[ ",${profiles}," == *",ai,"* ]] || [[ "${profiles}" == "ai" ]]; then
    return 0
  fi
  # Reuse AI profile if the optional Ollama service is already running.
  if docker_bin ps --format '{{.Names}}' 2>/dev/null | grep -qx 'horde-ollama'; then
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

resolve_horde_container() {
  local id
  id="$(compose ps -q horde 2>/dev/null || true)"
  if [[ -n "$id" ]]; then
    printf '%s' "$id"
    return 0
  fi
  if docker_bin inspect horde >/dev/null 2>&1; then
    printf 'horde'
    return 0
  fi
  return 1
}

write_live_snapshot() {
  local snap="$1"
  local cid mounts_file env_file port ollama_id ollama_mounts dl data puid pgid ollama_src
  cid="$(resolve_horde_container)" || return 1

  mounts_file="${snap}.mounts"
  env_file="${snap}.container-env"
  docker_bin inspect --format '{{range .Mounts}}{{.Destination}}={{.Source}}{{println}}{{end}}' "$cid" > "$mounts_file"
  docker_bin inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" > "$env_file"

  : > "$snap"
  dl="$(horde_mount_source "$mounts_file" /downloads)"
  data="$(horde_mount_source "$mounts_file" /app/data)"
  puid="$(horde_env_get "$env_file" PUID)"
  pgid="$(horde_env_get "$env_file" PGID)"
  [[ -n "$dl" ]] && horde_env_upsert "$snap" DOWNLOADS_PATH "$dl"
  [[ -n "$data" ]] && horde_env_upsert "$snap" DATA_PATH "$data"
  [[ -n "$puid" ]] && horde_env_upsert "$snap" PUID "$puid"
  [[ -n "$pgid" ]] && horde_env_upsert "$snap" PGID "$pgid"

  port="$(docker_bin inspect --format '{{(index (index .HostConfig.PortBindings "8080/tcp") 0).HostPort}}' "$cid" 2>/dev/null || true)"
  if [[ -n "$port" && "$port" != "<no value>" ]]; then
    horde_env_upsert "$snap" HOST_PORT "$port"
  fi

  ollama_id=""
  if docker_bin inspect horde-ollama >/dev/null 2>&1; then
    ollama_id="horde-ollama"
  fi
  if [[ -n "$ollama_id" ]]; then
    ollama_mounts="${snap}.ollama-mounts"
    docker_bin inspect --format '{{range .Mounts}}{{.Destination}}={{.Source}}{{println}}{{end}}' "$ollama_id" > "$ollama_mounts"
    ollama_src="$(horde_mount_source "$ollama_mounts" /root/.ollama)"
    [[ -n "$ollama_src" ]] && horde_env_upsert "$snap" OLLAMA_DATA_PATH "$ollama_src"
  fi
  return 0
}

planned_bind_mounts() {
  local json yaml extracted
  json="$(compose config --format json 2>/dev/null || true)"
  if [[ -n "$json" ]]; then
    extracted="$(horde_extract_horde_bind_mounts <<<"$json" || true)"
    if [[ -n "$extracted" ]]; then
      printf '%s\n' "$extracted"
      return 0
    fi
  fi
  yaml="$(compose config 2>/dev/null || true)"
  if [[ -n "$yaml" ]]; then
    horde_extract_horde_bind_mounts <<<"$yaml" || true
  fi
}

BACKUP_DIR="$ROOT/.local/update-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
SNAPSHOT="$BACKUP_DIR/live.env"
LIVE_DOWNLOADS=""
LIVE_DATA=""

if [[ -f "$ENV_FILE" ]]; then
  cp -a "$ENV_FILE" "$BACKUP_DIR/env.before"
fi

echo "Snapshotting running volume mounts so settings and library paths cannot reset..."
if write_live_snapshot "$SNAPSHOT"; then
  LIVE_DOWNLOADS="$(horde_env_get "$SNAPSHOT" DOWNLOADS_PATH)"
  LIVE_DATA="$(horde_env_get "$SNAPSHOT" DATA_PATH)"
  echo "  downloads: ${LIVE_DOWNLOADS:-(not mounted)}"
  echo "  data:      ${LIVE_DATA:-(not mounted)}"
  if [[ -n "$LIVE_DATA" && -f "${LIVE_DATA}/app_settings.json" ]]; then
    echo "  settings:  ${LIVE_DATA}/app_settings.json (keeping)"
  fi
  if [[ -n "$LIVE_DATA" && -f "${LIVE_DATA}/horde.db" ]]; then
    echo "  database:  ${LIVE_DATA}/horde.db (keeping)"
  fi
  horde_seed_env_from_snapshot "$ENV_FILE" "$SNAPSHOT"
  cp -a "$ENV_FILE" "$BACKUP_DIR/env.seeded"
  host_port="$(horde_env_get "$SNAPSHOT" HOST_PORT)"
  if [[ -z "${HORDE_HEALTH_URL:-}" && -n "$host_port" ]]; then
    HEALTH_URL="http://127.0.0.1:${host_port}/api/health"
  fi
else
  echo "  No existing Horde container; using .env / compose defaults."
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "  Warning: no .env found. Copy .env.example to .env and set DOWNLOADS_PATH and DATA_PATH" >&2
    echo "  so a later compose refresh cannot fall back to empty default directories." >&2
  fi
fi

horde_git_pull

# Re-apply live paths after pull in case a tracked file ever overwrote .env.
if [[ -f "$SNAPSHOT" ]]; then
  horde_seed_env_from_snapshot "$ENV_FILE" "$SNAPSHOT"
fi

SHA="$(git rev-parse HEAD)"

PLANNED_FILE="$BACKUP_DIR/planned.mounts"
planned_bind_mounts > "$PLANNED_FILE" || true
PLAN_DOWNLOADS="$(horde_mount_source "$PLANNED_FILE" /downloads)"
PLAN_DATA="$(horde_mount_source "$PLANNED_FILE" /app/data)"
if [[ -z "$PLAN_DOWNLOADS" ]]; then
  PLAN_DOWNLOADS="$(horde_env_get "$ENV_FILE" DOWNLOADS_PATH)"
fi
if [[ -z "$PLAN_DATA" ]]; then
  PLAN_DATA="$(horde_env_get "$ENV_FILE" DATA_PATH)"
fi

if [[ -n "$LIVE_DOWNLOADS" || -n "$LIVE_DATA" ]]; then
  if ! horde_guard_volume_paths "$LIVE_DOWNLOADS" "$LIVE_DATA" "$PLAN_DOWNLOADS" "$PLAN_DATA"; then
    if [[ "${HORDE_FORCE_VOLUME_CHANGE:-}" == "1" ]]; then
      echo "HORDE_FORCE_VOLUME_CHANGE=1 set; recreating with the new volume paths." >&2
    else
      echo >&2
      echo "Aborting: recreating the container would mount different host paths." >&2
      echo "That is what wipes settings (app_settings.json / horde.db) and looks like a storage-path reset." >&2
      echo "Live mounts are saved in ${ENV_FILE}. If you really intend to move data, set" >&2
      echo "  HORDE_FORCE_VOLUME_CHANGE=1" >&2
      echo "and run again. Snapshot: ${BACKUP_DIR}" >&2
      exit 1
    fi
  else
    echo "Volume paths unchanged; settings and library will be kept."
  fi
fi

echo "Building horde image at ${SHA:0:7}..."
compose build horde

UP_ARGS=(up -d)
if want_ai_profile; then
  echo "Including Compose profile: ai"
  UP_ARGS=(--profile ai up -d)
fi

echo "Recreating containers..."
compose "${UP_ARGS[@]}"

if [[ -n "$LIVE_DATA" ]]; then
  if [[ ! -f "${LIVE_DATA}/horde.db" && -f "$BACKUP_DIR/live.env" ]]; then
    echo "Warning: ${LIVE_DATA}/horde.db is missing after recreate. Check DATA_PATH in .env." >&2
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  echo
  echo "Updated to ${SHA:0:7}."
  echo "curl not found; skipped health wait. Open http://<server-ip>:8686 and hard-refresh (Ctrl+Shift+R)."
  echo "Library data and settings on host volumes are unchanged."
  exit 0
fi

echo
wait_for_health

echo
echo "Updated to ${SHA:0:7}."
echo "Hard-refresh the browser (Ctrl+Shift+R) if the UI looks stale."
echo "Library data and settings on host volumes are unchanged."
echo "If downloads fail after YouTube changes, see Maintenance → Bumping yt-dlp (/wiki/ops/maintenance/)."
