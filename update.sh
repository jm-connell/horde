#!/usr/bin/env bash
# Update Horde: back up the database, fast-forward the git checkout, rebuild the
# image (tagged horde:latest and horde:<shortsha>), restart, and wait for health.
# If the new version does not become healthy it is rolled back automatically.
# Run on the TrueNAS / Docker host (not inside the container Bash button).
#
# Usage (from your Dockge stack folder):
#   bash update.sh              update
#   bash update.sh --rollback   go back to the version before the last update
#   bash update.sh --rollback --restore-db
#                               ... and also restore the database backup taken
#                               by that update (loses newer data; see docs)
#
# Optional env:
#   HORDE_HEALTH_URL            Health endpoint to poll (default http://127.0.0.1:8686/api/health)
#   HORDE_COMPOSE_PROFILES      Compose profiles (e.g. ai); also honors COMPOSE_PROFILES
#   HORDE_HEALTH_TIMEOUT_SEC    Seconds to wait for health (default 90)
#   HORDE_FORCE_VOLUME_CHANGE=1 Allow recreate even if DOWNLOADS_PATH / DATA_PATH would move
#   HORDE_KEEP_BACKUPS          How many .local/update-backups/<timestamp> folders to keep (default 5)
#   HORDE_AUTO_ROLLBACK=0       Do not roll back automatically when the health check fails
#   HORDE_SKIP_DB_BACKUP=1      Continue even if the database cannot be backed up
#   HORDE_DISCARD_COMPOSE_EDITS=1  Back up, then discard local edits to the compose file
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

MODE="update"
RESTORE_DB=0
for arg in "$@"; do
  case "$arg" in
    --rollback) MODE="rollback" ;;
    --restore-db) RESTORE_DB=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

HEALTH_URL="${HORDE_HEALTH_URL:-http://127.0.0.1:8686/api/health}"
HEALTH_TIMEOUT_SEC="${HORDE_HEALTH_TIMEOUT_SEC:-90}"
KEEP_BACKUPS="${HORDE_KEEP_BACKUPS:-5}"
ENV_FILE="$ROOT/.env"
BACKUPS_ROOT="$ROOT/.local/update-backups"
STATE_FILE="$ROOT/.local/update-state.env"
SHA=""
VERSION="${HORDE_VERSION:-}"

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
    HORDE_GIT_SHA="${SHA:-unknown}" HORDE_VERSION="${VERSION:-dev}" docker compose "$@"
  else
    sudo HORDE_GIT_SHA="${SHA:-unknown}" HORDE_VERSION="${VERSION:-dev}" docker compose "$@"
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
  return 1
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

# Image the horde service runs: horde:latest when built here, or HORDE_IMAGE
# (a published image, see docs/getting-started/updating.md).
IMAGE_REF="${HORDE_IMAGE:-$(horde_env_get "$ENV_FILE" HORDE_IMAGE)}"
IMAGE_REF="${IMAGE_REF:-horde:latest}"
PUBLISHED_IMAGE=0
[[ -n "${HORDE_IMAGE:-$(horde_env_get "$ENV_FILE" HORDE_IMAGE)}" ]] && PUBLISHED_IMAGE=1

image_id() {
  docker_bin image inspect --format '{{.Id}}' "$1" 2>/dev/null || true
}

state_get() { horde_env_get "$STATE_FILE" "$1"; }
state_set() { horde_env_upsert "$STATE_FILE" "$1" "$2"; }

# Run scripts/sqlite_tool.py against the live DB inside the running container.
# Prints the tool's stdout; non-zero when the container cannot run it.
tool_in_container() {
  local cid="$1"
  shift
  docker_bin exec -i "$cid" python - "$@" < "$ROOT/scripts/sqlite_tool.py"
}

# Same, in a one-off container of IMAGE against the data dir DATA (used when the
# app container is stopped or unhealthy). Runs as the data owner, not root.
tool_in_image() {
  local image="$1" data="$2"
  shift 2
  local user="${PUID_VALUE:-1000}:${PGID_VALUE:-1000}"
  docker_bin run --rm -i --user "$user" --entrypoint python -v "${data}:/app/data" \
    "$image" - "$@" < "$ROOT/scripts/sqlite_tool.py"
}

# SQLite online backup (no downtime, consistent even in WAL mode) into
# $BACKUP_DIR/horde.db. Also records the schema revision before the update.
DB_BACKUP_PATH=""
REVISION_BEFORE=""
backup_database() {
  local cid out revision=""
  local dest="$BACKUP_DIR/horde.db"
  if [[ -z "$LIVE_DATA" || ! -f "${LIVE_DATA}/horde.db" ]]; then
    echo "No existing database to back up (fresh install)."
    return 0
  fi
  echo "Backing up the database (SQLite online backup) ..."
  if cid="$(resolve_horde_container)" \
    && out="$(tool_in_container "$cid" backup /tmp/horde-update-backup.db 2>&1)" \
    && docker_bin cp "${cid}:/tmp/horde-update-backup.db" "$dest" >/dev/null; then
    docker_bin exec "$cid" rm -f /tmp/horde-update-backup.db >/dev/null 2>&1 || true
    revision="$(tool_in_container "$cid" revision 2>/dev/null || true)"
  elif command -v python3 >/dev/null 2>&1 \
    && out="$(python3 "$ROOT/scripts/sqlite_tool.py" backup "$dest" "${LIVE_DATA}/horde.db" 2>&1)"; then
    revision="$(python3 "$ROOT/scripts/sqlite_tool.py" revision "${LIVE_DATA}/horde.db" 2>/dev/null || true)"
  else
    echo "Could not back up ${LIVE_DATA}/horde.db: ${out:-no running container and no python3 on the host}" >&2
    if [[ "${HORDE_SKIP_DB_BACKUP:-}" == "1" ]]; then
      echo "HORDE_SKIP_DB_BACKUP=1 set; continuing WITHOUT a database backup." >&2
      return 0
    fi
    echo "Aborting before the running version was touched. Fix the cause or set HORDE_SKIP_DB_BACKUP=1." >&2
    exit 1
  fi
  echo "  database backup: ${dest} ($(du -h "$dest" | cut -f1)), integrity ok"
  DB_BACKUP_PATH="$dest"
  REVISION_BEFORE="${revision:-none}"
}

# Put the previous image back as the horde image and recreate the container.
# Never builds or pulls: it must work offline and must not re-fetch the bad version.
recreate_previous() {
  local prev_image="$1" prev_sha="$2"
  docker_bin tag "$prev_image" "$IMAGE_REF"
  SHA="$prev_sha"
  compose "${UP_ARGS[@]}" --no-build --pull never --force-recreate
}

# Restore the database backup over the live one. The newer database is kept as
# horde.db.pre-rollback-<ts> next to it. Runs in a throwaway container as root
# so it works whatever the host permissions are, with the app stopped.
restore_database() {
  local backup_dir="$1" data="$2" image="$3" ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  compose stop horde >/dev/null 2>&1 || true
  # The script below runs inside the container, so single quotes are intended.
  # shellcheck disable=SC2016
  docker_bin run --rm --entrypoint sh -e "TS=$ts" \
    -v "${data}:/app/data" -v "${backup_dir}:/backup:ro" "$image" -c '
      set -e
      [ -f /app/data/horde.db ] && mv /app/data/horde.db "/app/data/horde.db.pre-rollback-$TS"
      rm -f /app/data/horde.db-wal /app/data/horde.db-shm
      cp /backup/horde.db /app/data/horde.db
      chown "$(stat -c %u:%g /app/data)" /app/data/horde.db'
}

# Roll back to the state recorded by the last update. $1 = reason shown to the
# user, $2 = "auto" (restore the DB when the schema revision changed) or "manual".
perform_rollback() {
  local reason="$1" how="$2"
  local prev_image prev_sha prev_branch backup revision_before revision_after new_image restore=0

  prev_image="$(state_get PREV_IMAGE_ID)"
  prev_sha="$(state_get PREV_GIT_SHA)"
  prev_branch="$(state_get GIT_BRANCH)"
  backup="$(state_get DB_BACKUP)"
  revision_before="$(state_get REVISION_BEFORE)"
  new_image="$(state_get NEW_IMAGE_ID)"

  echo
  echo "ROLLING BACK: ${reason}" >&2
  if [[ -z "$prev_image" || -z "$prev_sha" ]] || ! docker_bin image inspect "$prev_image" >/dev/null 2>&1; then
    echo "Cannot roll back: no previous image was recorded (${STATE_FILE}), or it was removed." >&2
    echo "Check logs: sudo docker compose logs --tail=80 horde" >&2
    return 2
  fi

  # Did a schema migration run? Compare the Alembic revision recorded before
  # the update with the one in the live database now (no revision table before
  # = "none", so the Alembic adoption counts as a migration too).
  if [[ -n "$LIVE_DATA" && -f "${LIVE_DATA}/horde.db" && -n "$revision_before" ]]; then
    compose stop horde >/dev/null 2>&1 || true
    revision_after="$(tool_in_image "${new_image:-$prev_image}" "$LIVE_DATA" revision 2>/dev/null || true)"
    if [[ -z "$revision_after" ]]; then
      # An unreadable revision means the failed version may have damaged the schema.
      echo "Could not read the schema revision of the current database." >&2
      revision_after="unreadable"
    fi
    if horde_schema_changed "$revision_before" "$revision_after"; then
      echo "A database schema migration ran during the update:" >&2
      echo "  before: ${revision_before}" >&2
      echo "  after:  ${revision_after}" >&2
      if [[ "$how" == "auto" || "$RESTORE_DB" -eq 1 ]]; then
        if [[ -f "$backup" ]]; then
          restore=1
        else
          echo "  ... but the backup ${backup:-<none>} is missing; cannot restore." >&2
        fi
      else
        echo "  The previous version will refuse to start on the migrated database (\"schema is at revision ... which this version of Horde does not know\")." >&2
        echo "  To also restore the pre-update backup (this DISCARDS everything written since):" >&2
        echo "    bash update.sh --rollback --restore-db" >&2
        echo "  (Horde also keeps its own pre-migration copies in DATA_PATH/backups/.)" >&2
      fi
    else
      echo "No schema migration ran; the database is left untouched."
    fi
  fi

  if [[ -n "$prev_branch" ]] && git rev-parse --verify -q "${prev_sha}^{commit}" >/dev/null; then
    echo "Restoring git checkout to ${prev_sha:0:7} on ${prev_branch} ..."
    git checkout -q -B "$prev_branch" "$prev_sha"
  fi

  if [[ "$restore" -eq 1 ]]; then
    echo "RESTORING DATABASE from ${backup}." >&2
    echo "Everything written to the database after that backup is discarded; the newer file is kept as horde.db.pre-rollback-*." >&2
    restore_database "$(dirname "$backup")" "$LIVE_DATA" "$prev_image"
  fi

  echo "Recreating containers on the previous image ..."
  recreate_previous "$prev_image" "$prev_sha"
  if command -v curl >/dev/null 2>&1; then
    if ! wait_for_health; then
      echo "The previous version is not healthy either. Inspect the logs and ${BACKUPS_ROOT}." >&2
      return 2
    fi
  fi
  return 0
}

ensure_data_user() {
  PUID_VALUE="$(horde_env_get "$ENV_FILE" PUID)"
  PGID_VALUE="$(horde_env_get "$ENV_FILE" PGID)"
  PUID_VALUE="${PUID_VALUE:-1000}"
  PGID_VALUE="${PGID_VALUE:-1000}"
}

BACKUP_DIR="$BACKUPS_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
horde_prune_backups "$BACKUPS_ROOT" "$KEEP_BACKUPS"
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
ensure_data_user

UP_ARGS=(up -d)
if want_ai_profile; then
  echo "Including Compose profile: ai"
  UP_ARGS=(--profile ai up -d)
fi

if [[ "$MODE" == "rollback" ]]; then
  if [[ -z "$LIVE_DATA" ]]; then
    LIVE_DATA="$(horde_env_get "$ENV_FILE" DATA_PATH)"
  fi
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "Nothing to roll back to: ${STATE_FILE} does not exist (no update has run here yet)." >&2
    exit 1
  fi
  echo "Rolling back to $(state_get PREV_GIT_SHA | cut -c1-7) (the version before the update of $(state_get UPDATED_AT))."
  if perform_rollback "manual rollback requested" manual; then
    echo
    echo "Rolled back to $(state_get PREV_GIT_SHA | cut -c1-7)."
    echo "Re-run 'bash update.sh' later to update again; this checkout was moved back, so the same upstream change will be pulled again."
    exit 0
  fi
  exit 1
fi

PREV_SHA="$(git rev-parse HEAD)"
PREV_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
PREV_IMAGE_ID="$(image_id "$IMAGE_REF")"

horde_git_pull "$BACKUP_DIR"

# Re-apply live paths after pull in case a tracked file ever overwrote .env.
if [[ -f "$SNAPSHOT" ]]; then
  horde_seed_env_from_snapshot "$ENV_FILE" "$SNAPSHOT"
fi

SHA="$(git rev-parse HEAD)"
SHORT="${SHA:0:7}"
VERSION="${VERSION:-$(horde_version_string)}"

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
      echo "A common cause is an .env that still has the TrueNAS example paths, or no .env at all, on another host" >&2
      echo "(see docs/getting-started/install-docker.md, 'Configure .env')." >&2
      echo "Live mounts are saved in ${ENV_FILE}. If you really intend to move data, set" >&2
      echo "  HORDE_FORCE_VOLUME_CHANGE=1" >&2
      echo "and run again. Snapshot: ${BACKUP_DIR}" >&2
      exit 1
    fi
  else
    echo "Volume paths unchanged; settings and library will be kept."
  fi
fi

# Last moment before anything changes: back up the database, then remember
# where we came from so a failed update can be undone.
backup_database

mkdir -p "$(dirname "$STATE_FILE")"
rm -f "$STATE_FILE"
state_set DB_BACKUP "$DB_BACKUP_PATH"
state_set REVISION_BEFORE "$REVISION_BEFORE"
state_set UPDATED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
state_set GIT_BRANCH "$PREV_BRANCH"
state_set PREV_GIT_SHA "$PREV_SHA"
state_set PREV_IMAGE_ID "$PREV_IMAGE_ID"
state_set NEW_GIT_SHA "$SHA"
if [[ -n "$PREV_IMAGE_ID" ]]; then
  # A named tag keeps the old image from being pruned as dangling.
  docker_bin tag "$PREV_IMAGE_ID" "horde:${PREV_SHA:0:7}" || true
fi

if [[ "$PUBLISHED_IMAGE" -eq 1 ]]; then
  echo "Pulling published image ${IMAGE_REF} ..."
  compose pull horde
else
  echo "Building horde image at ${SHORT} (version ${VERSION})..."
  compose build horde
  docker_bin tag "$IMAGE_REF" "horde:${SHORT}"
fi
NEW_IMAGE_ID="$(image_id "$IMAGE_REF")"
state_set NEW_IMAGE_ID "$NEW_IMAGE_ID"

echo "Recreating containers..."
compose "${UP_ARGS[@]}"

if [[ -n "$LIVE_DATA" ]]; then
  if [[ ! -f "${LIVE_DATA}/horde.db" && -f "$BACKUP_DIR/live.env" ]]; then
    echo "Warning: ${LIVE_DATA}/horde.db is missing after recreate. Check DATA_PATH in .env." >&2
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  echo
  echo "Updated to ${SHORT}."
  echo "curl not found; skipped health wait and automatic rollback. Open http://<server-ip>:8686 and hard-refresh (Ctrl+Shift+R)."
  echo "Library data and settings on host volumes are unchanged."
  exit 0
fi

echo
if ! wait_for_health; then
  if [[ "${HORDE_AUTO_ROLLBACK:-1}" == "0" ]]; then
    echo "HORDE_AUTO_ROLLBACK=0: leaving the new version running. Roll back with: bash update.sh --rollback" >&2
    exit 1
  fi
  if [[ -z "$PREV_IMAGE_ID" ]]; then
    echo "No previous image existed (first install?), so there is nothing to roll back to." >&2
    exit 1
  fi
  # The failed container is about to be replaced; keep its log for diagnosis.
  compose logs --no-color --tail=200 horde > "$BACKUP_DIR/failed-container.log" 2>&1 || true
  if perform_rollback "the new version (${SHORT}) did not become healthy" auto; then
    {
      echo
      echo "UPDATE FAILED and was rolled back to ${PREV_SHA:0:7}; Horde is running the previous version."
      echo "Log of the failed version: ${BACKUP_DIR}/failed-container.log"
      echo "Backups from this attempt: ${BACKUP_DIR}"
    } >&2
  fi
  exit 1
fi

# Record the schema revision the new version produced (for a later --rollback).
if cid="$(resolve_horde_container)"; then
  state_set REVISION_AFTER "$(tool_in_container "$cid" revision 2>/dev/null || true)"
fi

echo
echo "Updated to ${SHORT}."
if [[ -n "$PREV_IMAGE_ID" ]]; then
  echo "Previous version kept for rollback: horde:${PREV_SHA:0:7}  (bash update.sh --rollback)"
fi
echo "Database backup: ${BACKUP_DIR}/horde.db"
echo "Hard-refresh the browser (Ctrl+Shift+R) if the UI looks stale."
echo "Library data and settings on host volumes are unchanged."
echo "If downloads fail after YouTube changes, see Maintenance → Bumping yt-dlp (/wiki/ops/maintenance/)."
