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
#   HORDE_HEALTH_TIMEOUT_SEC    Seconds to wait for health (default 90; 150 with YTDLP_AUTO_UPDATE=1)
#   HORDE_FORCE_VOLUME_CHANGE=1 Allow recreate even if DOWNLOADS_PATH / DATA_PATH would move
#   HORDE_KEEP_BACKUPS          How many .local/update-backups/<timestamp> folders to keep (default 5)
#   HORDE_KEEP_IMAGES           How many horde:<sha> image tags to keep (default 3)
#   HORDE_HEALTH_POLL_SEC       Seconds between health polls (default 2)
#   HORDE_UPDATE_CHANNEL        release (default: the newest vX.Y.Z tag), prerelease, or main
#   HORDE_ALLOW_DOWNGRADE=1     Allow switching to a release older than your checkout
#   HORDE_FORCE_REBUILD=1       Rebuild even when the checkout is already at the running commit
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

# Outcome for the in-app update button (scripts/update_watch.sh): when
# HORDE_UPDATE_RESULT_FILE is set, one line RESULT=<word> is written on exit:
# updated, up_to_date, rolled_back or failed.
RESULT="failed"
report_result() {
  if [[ -n "${HORDE_UPDATE_RESULT_FILE:-}" ]]; then
    printf 'RESULT=%s\n' "$RESULT" > "$HORDE_UPDATE_RESULT_FILE" || true
  fi
}
trap report_result EXIT

HEALTH_URL="${HORDE_HEALTH_URL:-http://127.0.0.1:8686/api/health}"
KEEP_BACKUPS="${HORDE_KEEP_BACKUPS:-5}"
KEEP_IMAGES="${HORDE_KEEP_IMAGES:-3}"
ENV_FILE="$ROOT/.env"
# Update-channel settings may live in .env (the shell wins).
HORDE_UPDATE_CHANNEL="${HORDE_UPDATE_CHANNEL:-$(horde_env_get "$ENV_FILE" HORDE_UPDATE_CHANNEL)}"
HORDE_ALLOW_DOWNGRADE="${HORDE_ALLOW_DOWNGRADE:-$(horde_env_get "$ENV_FILE" HORDE_ALLOW_DOWNGRADE)}"
export HORDE_UPDATE_CHANNEL HORDE_ALLOW_DOWNGRADE
# The yt-dlp updater (YTDLP_AUTO_UPDATE=1) runs before the app starts, so give
# the health wait room for it.
HEALTH_DEFAULT=90
if [[ "${YTDLP_AUTO_UPDATE:-$(horde_env_get "$ENV_FILE" YTDLP_AUTO_UPDATE)}" == "1" ]]; then
  HEALTH_DEFAULT=150
fi
HEALTH_TIMEOUT_SEC="${HORDE_HEALTH_TIMEOUT_SEC:-$HEALTH_DEFAULT}"
HEALTH_POLL_SEC="${HORDE_HEALTH_POLL_SEC:-2}"
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
  # Poll every HEALTH_POLL_SEC for about HEALTH_TIMEOUT_SEC (both may be
  # fractional; each request is capped at 5s so a hung server cannot stall it).
  local attempts body=""
  attempts="$(awk -v t="$HEALTH_TIMEOUT_SEC" -v p="$HEALTH_POLL_SEC" 'BEGIN { n = int(t / p); print (n < 1 ? 1 : n) }')"
  echo "Waiting for ${HEALTH_URL} (up to ${HEALTH_TIMEOUT_SEC}s) ..."
  while (( attempts > 0 )); do
    attempts=$((attempts - 1))
    if body="$(curl -sf -m 5 "$HEALTH_URL" 2>/dev/null)"; then
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
    sleep "$HEALTH_POLL_SEC"
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

# Commit baked into an image (OCI revision label set by the Dockerfile); empty
# for images built before the label existed.
image_revision() {
  docker_bin image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null || true
}

state_get() { horde_env_get "$STATE_FILE" "$1"; }
state_set() { horde_env_upsert "$STATE_FILE" "$1" "$2"; }

# --- where the SQLite tool runs ------------------------------------------------
# scripts/sqlite_tool.py is run in the running container (docker exec), on the
# host when python3 can read the file, or in a throwaway container of the
# current image. Never decide "there is no database" from a host-side test:
# a 0700 PUID-owned dataset is invisible to the invoking user.

running_container() {
  local id
  id="$(compose ps -q horde 2>/dev/null || true)"
  [[ -n "$id" ]] || return 1
  [[ "$(docker_bin inspect --format '{{.State.Running}}' "$id" 2>/dev/null || true)" == "true" ]] || return 1
  printf '%s' "$id"
}

# Stdin of `docker exec/run -i` is the script itself.
tool_in_container() {
  local cid="$1"
  shift
  docker_bin exec -i "$cid" python - "$@" < "$ROOT/scripts/sqlite_tool.py"
}

# One-off container of IMAGE against the data dir DATA, as the data owner.
tool_in_image() {
  local image="$1" data="$2"
  shift 2
  local user="${PUID_VALUE:-1000}:${PGID_VALUE:-1000}"
  docker_bin run --rm -i --user "$user" --entrypoint python -v "${data}:/app/data" \
    "$image" - "$@" < "$ROOT/scripts/sqlite_tool.py"
}

# Choose where to run the tool. Sets TOOL_MODE (container|host|image|none) and
# TOOL_CID / TOOL_IMAGE / TOOL_DATA. $1 = data dir, $2 = image to use for the
# one-off container fallback.
select_tool() {
  local data="$1" image="$2"
  TOOL_MODE="none"
  TOOL_CID=""
  TOOL_IMAGE="$image"
  TOOL_DATA="$data"
  if TOOL_CID="$(running_container)"; then
    TOOL_MODE="container"
  elif command -v python3 >/dev/null 2>&1 && [[ -n "$data" && -r "${data}/horde.db" ]]; then
    TOOL_MODE="host"
  elif [[ -n "$image" && -n "$data" ]]; then
    TOOL_MODE="image"
  fi
}

# Run a sqlite_tool command (not `backup`). Output in TOOL_OUT, tool exit status
# returned: 0 ok, 3 no database, anything else a failure.
db_tool() {
  local rc=0
  case "$TOOL_MODE" in
    container) TOOL_OUT="$(tool_in_container "$TOOL_CID" "$@" 2>&1)" || rc=$? ;;
    host) TOOL_OUT="$(python3 "$ROOT/scripts/sqlite_tool.py" "$1" "${TOOL_DATA}/horde.db" 2>&1)" || rc=$? ;;
    image) TOOL_OUT="$(tool_in_image "$TOOL_IMAGE" "$TOOL_DATA" "$@" 2>&1)" || rc=$? ;;
    *)
      # No container, no image and no python3 that can read the file. That is a
      # fresh install only if the data directory is visibly empty (or absent).
      if [[ -z "$TOOL_DATA" || ! -e "$TOOL_DATA" || ( -r "$TOOL_DATA" && ! -e "$TOOL_DATA/horde.db" ) ]]; then
        TOOL_OUT="no database"
        rc=3
      else
        TOOL_OUT="no running container, image or readable data directory to run the SQLite tool"
        rc=127
      fi
      ;;
  esac
  return "$rc"
}

# Read the Alembic revision into DB_REVISION / DB_STATUS (ok|missing|unknown).
read_revision() {
  local rc=0
  DB_REVISION=""
  db_tool revision || rc=$?
  case "$rc" in
    0) DB_STATUS="ok"; DB_REVISION="$(printf '%s' "$TOOL_OUT" | tail -n 1)" ;;
    3) DB_STATUS="missing" ;;
    *) DB_STATUS="unknown" ;;
  esac
}

# SQLite online backup (no downtime, consistent even in WAL mode) into $1.
db_backup() {
  local dest="$1" rc=0 name
  case "$TOOL_MODE" in
    container)
      TOOL_OUT="$(tool_in_container "$TOOL_CID" backup /tmp/horde-update-backup.db 2>&1)" || rc=$?
      if [[ "$rc" -eq 0 ]]; then
        docker_bin cp "${TOOL_CID}:/tmp/horde-update-backup.db" "$dest" >/dev/null || rc=$?
        docker_bin exec "$TOOL_CID" rm -f /tmp/horde-update-backup.db >/dev/null 2>&1 || true
      fi
      ;;
    host)
      TOOL_OUT="$(python3 "$ROOT/scripts/sqlite_tool.py" backup "$dest" "${TOOL_DATA}/horde.db" 2>&1)" || rc=$?
      ;;
    image)
      name="horde-update-tool-$$"
      TOOL_OUT="$(docker_bin run -i --name "$name" --user "${PUID_VALUE:-1000}:${PGID_VALUE:-1000}" \
        --entrypoint python -v "${TOOL_DATA}:/app/data" "$TOOL_IMAGE" - backup /tmp/horde-update-backup.db \
        < "$ROOT/scripts/sqlite_tool.py" 2>&1)" || rc=$?
      if [[ "$rc" -eq 0 ]]; then
        docker_bin cp "${name}:/tmp/horde-update-backup.db" "$dest" >/dev/null || rc=$?
      fi
      docker_bin rm -f "$name" >/dev/null 2>&1 || true
      ;;
    *)
      TOOL_OUT="no way to run the SQLite tool"
      rc=127
      ;;
  esac
  return "$rc"
}

# Create the per-update backup folder (once) and keep the snapshot files in it.
ensure_backup_dir() {
  [[ -d "$BACKUP_DIR" ]] && return 0
  mkdir -p "$BACKUP_DIR"
  cp -a "$SNAP_DIR"/. "$BACKUP_DIR"/ 2>/dev/null || true
}

# Back up the database just before `compose up`. Records the schema revision
# before the update. A missing database (tool exit 3) is a fresh install; every
# other failure aborts unless HORDE_SKIP_DB_BACKUP=1.
DB_BACKUP_PATH=""
REVISION_BEFORE=""
backup_database() {
  local dest="$BACKUP_DIR/horde.db" why=""
  select_tool "${LIVE_DATA:-$PLAN_DATA}" "$PREV_IMAGE_ID"
  read_revision
  case "$DB_STATUS" in
    missing)
      echo "No existing database to back up (fresh install)."
      return 0
      ;;
    unknown)
      why="could not read the database: ${TOOL_OUT}"
      ;;
    *)
      REVISION_BEFORE="$DB_REVISION"
      ensure_backup_dir
      echo "Backing up the database (SQLite online backup, via ${TOOL_MODE}) ..."
      if db_backup "$dest"; then
        echo "  database backup: ${dest} ($(du -h "$dest" | cut -f1)), integrity ok (schema revision ${REVISION_BEFORE})"
        DB_BACKUP_PATH="$dest"
        return 0
      fi
      why="the backup failed: ${TOOL_OUT}"
      ;;
  esac
  echo "Cannot back up the database: ${why}" >&2
  REVISION_BEFORE=""
  if [[ "${HORDE_SKIP_DB_BACKUP:-}" == "1" ]]; then
    echo "HORDE_SKIP_DB_BACKUP=1 set; continuing WITHOUT a database backup." >&2
    return 0
  fi
  echo "Aborting before the running version was touched. Fix the cause or set HORDE_SKIP_DB_BACKUP=1." >&2
  exit 1
}

# Put the previous image back as the horde image and recreate the container.
# Never builds or pulls: it must work offline and must not re-fetch the bad version.
recreate_previous() {
  local prev_image="$1" prev_sha="$2"
  docker_bin tag "$prev_image" "$IMAGE_REF" || return 1
  SHA="$prev_sha"
  compose "${UP_ARGS[@]}" --no-build --pull never --force-recreate
}

# Restore the database backup over the live one, with the app stopped, in a
# throwaway container (root, so host permissions do not matter) running
# scripts/restore_db.sh: verified copy, atomic rename, newer database kept as
# horde.db.pre-rollback-<ts>. On any failure nothing is deleted and the
# non-zero status is returned.
restore_database() {
  local backup_dir="$1" data="$2" image="$3" ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  compose stop horde >/dev/null 2>&1 || true
  docker_bin run --rm --entrypoint sh \
    -v "${data}:/app/data" -v "${backup_dir}:/backup:ro" \
    -v "$ROOT/scripts/restore_db.sh:/restore_db.sh:ro" \
    "$image" /restore_db.sh /app/data /backup/horde.db "$ts" || {
    docker_bin run --rm --entrypoint rm -v "${data}:/app/data" "$image" -f /app/data/horde.db.restoring >/dev/null 2>&1 || true
    return 1
  }
}

# Roll back to the state recorded by the last update. $1 = reason shown to the
# user, $2 = "auto" (restore the DB when the schema revision changed) or "manual".
# Everything that can refuse is checked BEFORE anything is stopped or changed;
# every later step is checked explicitly (this runs inside `if`, where set -e is
# off). Returns 0 ok, 2 failed, 3 refused without changing anything.
perform_rollback() {
  local reason="$1" how="$2"
  local prev_image prev_sha prev_branch new_sha new_branch new_image backup revision_before restore=0
  local cur_branch cur_sha

  prev_image="$(state_get PREV_IMAGE_ID)"
  prev_sha="$(state_get PREV_GIT_SHA)"
  prev_branch="$(state_get GIT_BRANCH)"
  new_sha="$(state_get NEW_GIT_SHA)"
  new_branch="$(state_get NEW_BRANCH)"
  new_branch="${new_branch:-$prev_branch}"
  new_image="$(state_get NEW_IMAGE_ID)"
  backup="$(state_get DB_BACKUP)"
  revision_before="$(state_get REVISION_BEFORE)"

  echo
  echo "ROLLING BACK: ${reason}" >&2
  if [[ -z "$prev_image" || -z "$prev_sha" ]] || ! docker_bin image inspect "$prev_image" >/dev/null 2>&1; then
    echo "Cannot roll back: no previous image was recorded (${STATE_FILE}), or it was removed." >&2
    echo "Check logs: sudo docker compose logs --tail=80 horde" >&2
    return 2
  fi

  # Git: only move the checkout back if it is still exactly where the update
  # left it. Later commits of yours are never dropped silently.
  cur_branch="$(git rev-parse --abbrev-ref HEAD)"
  cur_sha="$(git rev-parse HEAD)"
  GIT_ACTION="none"
  if [[ "$cur_sha" != "$prev_sha" ]]; then
    if [[ "$cur_sha" != "$new_sha" || ( -n "$new_branch" && "$cur_branch" != "$new_branch" ) ]]; then
      {
        echo "Stopping: the checkout is at ${cur_sha:0:7} on ${cur_branch}, not where the update left it"
        echo "(${new_sha:0:7} on ${new_branch}). Nothing was changed."
        echo "To go back to the previous version yourself:"
        echo "  git switch ${prev_branch:-main} && git reset --keep ${prev_sha}"
        echo "then re-run: bash update.sh --rollback"
      } >&2
      return 3
    fi
    GIT_ACTION="reset"
  fi

  # Did a schema migration run? Compare the Alembic revision recorded before
  # the update with the one in the live database now (no revision table before
  # = "none", so the Alembic adoption counts as a migration too). Read it
  # without stopping a running app; after a failed update the app is stopped
  # first, since it is not serving anyway.
  if [[ "$how" == "auto" ]]; then
    compose stop horde >/dev/null 2>&1 || true
  fi
  local changed=0 unknown=0
  if [[ -n "$LIVE_DATA" ]]; then
    select_tool "$LIVE_DATA" "${new_image:-$prev_image}"
    read_revision
    case "$DB_STATUS" in
      ok)
        if horde_schema_changed "$revision_before" "$DB_REVISION"; then
          changed=1
          echo "A database schema migration ran during the update:" >&2
          echo "  before: ${revision_before}" >&2
          echo "  after:  ${DB_REVISION}" >&2
        else
          echo "No schema migration ran; the database is left untouched."
        fi
        ;;
      missing) echo "There is no database to protect." ;;
      *)
        unknown=1
        echo "Could not read the schema revision of the current database: ${TOOL_OUT}" >&2
        ;;
    esac
  fi

  if [[ "$RESTORE_DB" -eq 1 ]]; then
    restore=1
  elif [[ "$changed" -eq 1 || "$unknown" -eq 1 ]]; then
    if [[ "$how" == "auto" && "$changed" -eq 1 ]]; then
      restore=1
    elif [[ "$how" == "manual" && "$changed" -eq 1 && "$unknown" -eq 0 ]] \
      && horde_old_version_tolerates_schema "$revision_before"; then
      {
        echo "The previous version predates the migration system and runs on the migrated database."
        echo "Going back WITHOUT restoring the database. Note:"
        echo "  - watch history recorded per account since the update is not visible to the previous version;"
        echo "  - history the previous version records is not picked up again when you update;"
        echo "  - AI chat messages the previous version writes stay unowned (no account sees them)."
        echo "To discard everything written since the update instead:"
        echo "  bash update.sh --rollback --restore-db"
      } >&2
    else
      {
        if [[ "$changed" -eq 1 ]]; then
          echo "The previous version refuses to start on the migrated database"
          echo "(\"schema is at revision ... which this version of Horde does not know\")."
        else
          echo "The state of the database could not be determined, so it is NOT restored automatically."
        fi
        echo "To restore the pre-update backup (this DISCARDS everything written since):"
        echo "  bash update.sh --rollback --restore-db"
        echo "(Horde also keeps its own pre-migration copies in DATA_PATH/backups/.)"
      } >&2
      if [[ "$how" == "manual" ]]; then
        echo "Nothing was changed." >&2
        return 3
      fi
    fi
  fi
  if [[ "$restore" -eq 1 && ! -f "$backup" ]]; then
    echo "Cannot restore: the backup ${backup:-<none>} is missing. Nothing was changed." >&2
    return 2
  fi

  if [[ "$restore" -eq 1 ]]; then
    echo "RESTORING DATABASE from ${backup}." >&2
    echo "Everything written to the database after that backup is discarded; the newer file is kept as horde.db.pre-rollback-*." >&2
    if ! restore_database "$(dirname "$backup")" "$LIVE_DATA" "$prev_image"; then
      {
        echo "RESTORE FAILED. Horde is stopped. The current database was NOT replaced"
        echo "(any horde.db.pre-rollback-* file next to it is a safe copy; do not delete it)."
        echo "Check free space and permissions on ${LIVE_DATA}, then run: bash update.sh --rollback --restore-db"
        echo "The backup is ${backup}."
      } >&2
      return 2
    fi
  fi

  if [[ "$GIT_ACTION" == "reset" ]]; then
    echo "Restoring git checkout to ${prev_sha:0:7} (${prev_branch:-$cur_branch}) ..."
    local moved=0
    if [[ "$prev_branch" == "HEAD" ]]; then
      git checkout -q --detach "$prev_sha" && moved=1
    elif [[ -z "$prev_branch" || "$prev_branch" == "$cur_branch" ]]; then
      git reset --keep "$prev_sha" && moved=1
    else
      # The update moved from another branch (main -> horde-release): go back to it.
      git checkout -q "$prev_branch" && { [[ "$(git rev-parse HEAD)" == "$prev_sha" ]] || git reset --keep "$prev_sha"; } && moved=1
    fi
    if [[ "$moved" -ne 1 ]]; then
      echo "Could not move the checkout back to ${prev_sha} (local changes in the way?). The database was already handled; fix git and re-run." >&2
      return 2
    fi
  fi

  echo "Recreating containers on the previous image ..."
  if ! recreate_previous "$prev_image" "$prev_sha"; then
    echo "Could not recreate the containers on the previous image." >&2
    return 2
  fi
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

# Keep the newest KEEP_IMAGES horde:<shortsha> tags (plus the current and the
# previous one, which rollback needs). Untagging only; images in use stay.
prune_image_tags() {
  local keep_now="$1" keep_prev="$2" n=0 tag
  [[ "$KEEP_IMAGES" =~ ^[0-9]+$ ]] || return 0
  while IFS= read -r tag; do
    [[ "$tag" =~ ^[0-9a-f]{7}$ ]] || continue
    n=$((n + 1))
    if [[ "$n" -le "$KEEP_IMAGES" || "$tag" == "$keep_now" || "$tag" == "$keep_prev" ]]; then
      continue
    fi
    docker_bin rmi "horde:${tag}" >/dev/null 2>&1 || true
  done < <(docker_bin image ls horde --format '{{.CreatedAt}}|{{.Tag}}' 2>/dev/null | LC_ALL=C sort -r | cut -d'|' -f2)
}

# Snapshot files live in a scratch dir; the per-update backup folder is only
# created when there is something to back up, so aborted runs leave nothing.
mkdir -p "$ROOT/.local"
SNAP_DIR="$(mktemp -d "$ROOT/.local/update-snap.XXXXXX")"
trap 'rm -rf "$SNAP_DIR"; report_result' EXIT
BACKUP_DIR="$BACKUPS_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT="$SNAP_DIR/live.env"
LIVE_DOWNLOADS=""
LIVE_DATA=""

if [[ -f "$ENV_FILE" ]]; then
  cp -a "$ENV_FILE" "$SNAP_DIR/env.before"
fi

echo "Snapshotting running volume mounts so settings and library paths cannot reset..."
if write_live_snapshot "$SNAPSHOT"; then
  LIVE_DOWNLOADS="$(horde_env_get "$SNAPSHOT" DOWNLOADS_PATH)"
  LIVE_DATA="$(horde_env_get "$SNAPSHOT" DATA_PATH)"
  echo "  downloads: ${LIVE_DOWNLOADS:-(not mounted)}"
  echo "  data:      ${LIVE_DATA:-(not mounted)}"
  horde_seed_env_from_snapshot "$ENV_FILE" "$SNAPSHOT"
  cp -a "$ENV_FILE" "$SNAP_DIR/env.seeded"
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
  rc=0
  perform_rollback "manual rollback requested" manual || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    echo
    RESULT="rolled_back"
    echo "Rolled back to $(state_get PREV_GIT_SHA | cut -c1-7)."
    echo "Re-run 'bash update.sh' later to update again; this checkout was moved back, so the same upstream change will be pulled again."
    exit 0
  fi
  exit 1
fi

PREV_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
PREV_IMAGE_ID="$(image_id "$IMAGE_REF")"
# The commit of what is deployed is the one baked into the image, not the
# checkout's HEAD: an earlier aborted run may already have pulled newer code.
PREV_SHA="$(image_revision "$PREV_IMAGE_ID")"
if ! [[ "$PREV_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  PREV_SHA="$(git rev-parse HEAD)"
fi

horde_git_pull "$BACKUP_DIR"

# Re-apply live paths after pull in case a tracked file ever overwrote .env.
if [[ -f "$SNAPSHOT" ]]; then
  horde_seed_env_from_snapshot "$ENV_FILE" "$SNAPSHOT"
fi

SHA="$(git rev-parse HEAD)"
SHORT="${SHA:0:7}"

# Nothing new and the image exists: do not touch anything, above all not the
# rollback point recorded by the last real update.
RUNNING_IMAGE=""
if cid="$(running_container)"; then
  RUNNING_IMAGE="$(docker_bin inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
fi
if [[ "$SHA" == "$PREV_SHA" && -n "$PREV_IMAGE_ID" && "$RUNNING_IMAGE" == "$PREV_IMAGE_ID" \
  && "$(image_revision "$PREV_IMAGE_ID")" == "$SHA" && "${HORDE_FORCE_REBUILD:-}" != "1" ]]; then
  echo
  echo "Already up to date at ${SHORT}; the running container uses the current image. Nothing to do."
  echo "(HORDE_FORCE_REBUILD=1 rebuilds anyway.)"
  RESULT="up_to_date"
  exit 0
fi
VERSION="${VERSION:-$(horde_version_string)}"

PLANNED_FILE="$SNAP_DIR/planned.mounts"
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
      echo "and run again." >&2
      exit 1
    fi
  else
    echo "Volume paths unchanged; settings and library will be kept."
  fi
fi

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

# The build succeeded; the last moment before anything running changes: back up
# the database, then record where we came from so a failed update can be undone.
REBUILD_SAME=0
if [[ "$SHA" == "$PREV_SHA" && -f "$STATE_FILE" ]]; then
  REBUILD_SAME=1 # same commit rebuilt: keep the rollback point of the real update
fi
if [[ "$REBUILD_SAME" -eq 0 ]]; then
  backup_database
  mkdir -p "$(dirname "$STATE_FILE")"
  rm -f "$STATE_FILE"
  state_set DB_BACKUP "$DB_BACKUP_PATH"
  state_set REVISION_BEFORE "$REVISION_BEFORE"
  state_set GIT_BRANCH "$PREV_BRANCH"
  state_set NEW_BRANCH "$(git rev-parse --abbrev-ref HEAD)"
  state_set PREV_GIT_SHA "$PREV_SHA"
  state_set PREV_IMAGE_ID "$PREV_IMAGE_ID"
  horde_prune_backups "$BACKUPS_ROOT" "$KEEP_BACKUPS" "${DB_BACKUP_PATH:+$(dirname "$DB_BACKUP_PATH")}"
fi
state_set UPDATED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
state_set NEW_GIT_SHA "$SHA"
state_set NEW_IMAGE_ID "$NEW_IMAGE_ID"

echo "Recreating containers..."
compose "${UP_ARGS[@]}"

if ! command -v curl >/dev/null 2>&1; then
  echo
  RESULT="updated"
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
  if [[ "$REBUILD_SAME" -eq 1 ]]; then
    echo "The rebuilt image of the running commit is not healthy; roll back with: bash update.sh --rollback" >&2
    exit 1
  fi
  if [[ -z "$PREV_IMAGE_ID" ]]; then
    echo "No previous image existed (first install?), so there is nothing to roll back to." >&2
    exit 1
  fi
  # The failed container is about to be replaced; keep its log for diagnosis.
  ensure_backup_dir
  compose logs --no-color --tail=200 horde > "$BACKUP_DIR/failed-container.log" 2>&1 || true
  rc=0
  perform_rollback "the new version (${SHORT}) did not become healthy" auto || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    RESULT="rolled_back"
    {
      echo
      echo "UPDATE FAILED and was rolled back to ${PREV_SHA:0:7}; Horde is running the previous version."
      echo "Log of the failed version: ${BACKUP_DIR}/failed-container.log"
      echo "Backups from this attempt: ${BACKUP_DIR}"
    } >&2
  fi
  exit 1
fi

prune_image_tags "$SHORT" "${PREV_SHA:0:7}"
RESULT="updated"

echo
echo "Updated to ${SHORT}."
if [[ -n "$PREV_IMAGE_ID" ]]; then
  echo "Previous version kept for rollback: horde:${PREV_SHA:0:7}  (bash update.sh --rollback)"
fi
if [[ -n "$DB_BACKUP_PATH" ]]; then
  echo "Database backup: ${DB_BACKUP_PATH}"
fi
echo "Hard-refresh the browser (Ctrl+Shift+R) if the UI looks stale."
echo "Library data and settings on host volumes are unchanged."
echo "If downloads fail after YouTube changes, see Maintenance → Bumping yt-dlp (/wiki/ops/maintenance/)."
