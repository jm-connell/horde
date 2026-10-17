#!/usr/bin/env bash
# Run update.sh when an administrator presses "Update now" in Horde.
#
# Horde runs in a container and cannot rebuild itself, so the button only
# leaves a request file in Horde's data folder (DATA_PATH/update/request.env).
# This script runs on the Docker host (TrueNAS: a Cron Job every minute, as
# root), picks the request up, runs update.sh and writes the outcome back
# where Horde can show it. Horde never gets access to Docker.
#
# Usage (from the Horde stack folder, or with the full path):
#   bash scripts/update_watch.sh           check once (what the cron job runs)
#   bash scripts/update_watch.sh --setup   check once and print the cron command
#
# Files in DATA_PATH/update/ (key=value lines):
#   watcher.env   LAST_SEEN: written on every run, so Horde knows this is set up
#   request.env   REQUEST_ID, REQUESTED_AT, REQUESTED_BY: written by Horde
#   current.env   the request being (or last) handled, moved from request.env
#   status.env    STATE (running, updated, up_to_date, rolled_back, failed,
#                 interrupted), REQUEST_ID, STARTED_AT, FINISHED_AT, EXIT_CODE
#   update.log    output of the last update.sh run
#
# Nothing is printed unless something goes wrong or an update ran, so cron
# stays quiet.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Cron starts with a minimal PATH.
export PATH="${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# shellcheck source=scripts/update_lib.sh
source "$ROOT/scripts/update_lib.sh"

SETUP=0
for arg in "$@"; do
  case "$arg" in
    --setup) SETUP=1 ;;
    -h | --help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

docker_bin() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    sudo -n docker "$@"
  fi
}

# Host path of Horde's data folder: the live container's /app/data mount, else
# DATA_PATH from .env.
data_dir() {
  local mounts dir
  mounts="$(mktemp)"
  if docker_bin inspect --format '{{range .Mounts}}{{.Destination}}={{.Source}}{{println}}{{end}}' horde >"$mounts" 2>/dev/null; then
    dir="$(horde_mount_source "$mounts" /app/data)"
  fi
  rm -f "$mounts"
  if [[ -z "${dir:-}" ]]; then
    dir="$(horde_env_get "$ROOT/.env" DATA_PATH)"
  fi
  printf '%s' "${dir:-}"
}

DATA="$(data_dir)"
if [[ -z "$DATA" || ! -d "$DATA" ]]; then
  echo "Horde's data folder was not found (no running 'horde' container and no DATA_PATH in $ROOT/.env)." >&2
  exit 1
fi
DATA="$(realpath -e -- "$DATA")"
DIR="$DATA/update"

# Horde (the container user, owner of the data folder) controls everything in
# DIR, so a compromised Horde could plant links, FIFOs or huge files there.
# Every read and write in DIR therefore runs as that owner, never as root, from
# inside DIR itself (refused unless it really is DATA/update, not a link to some
# other folder of the same user), without following links (dd nofollow), with
# new files created exclusively and reads capped in size.
DATA_UID="$(stat -c %u "$DATA")"
DATA_GID="$(stat -c %g "$DATA")"
as_owner() {
  if [[ "$(id -u)" -eq 0 && "$DATA_UID" != "0" ]]; then
    setpriv --reuid="$DATA_UID" --regid="$DATA_GID" --clear-groups -- "$@"
  else
    "$@"
  fi
}
if [[ "$(id -u)" -eq 0 && "$DATA_UID" != "0" ]] && ! command -v setpriv >/dev/null 2>&1; then
  echo "setpriv is required (package util-linux)." >&2
  exit 1
fi

# Run the sh snippet $1 as the owner with DIR as working directory; further
# arguments become $1... of the snippet.
in_dir() {
  local script="$1"
  shift
  # shellcheck disable=SC2016 # expanded by the inner sh
  as_owner sh -c 'cd -P -- "$1" 2>/dev/null && [ "$(pwd -P)" = "$1" ] || {
      echo "$1 is not a plain folder (a link?); refusing to use it." >&2
      exit 97
    }
    shift
    umask 022
    '"$script" sh "$DIR" "$@"
}

# Write stdin to DIR/$1 atomically (new temp file + rename), readable by Horde.
write_file() {
  # shellcheck disable=SC2016 # expanded by the inner sh
  in_dir 't="$(mktemp -u .tmp.XXXXXX)" && dd of="$t" conv=excl oflag=nofollow status=none && mv -fT -- "$t" "$1"' "$1"
}

# Value of KEY $2 in DIR/$1 (read as the owner; at most 64 KiB, no links).
read_key() {
  local tmp value
  tmp="$(mktemp)"
  # shellcheck disable=SC2016 # expanded by the inner sh
  in_dir 'dd if="$1" iflag=nofollow,nonblock bs=65536 count=1 status=none' "$1" >"$tmp" 2>/dev/null || true
  value="$(horde_env_get "$tmp" "$2")"
  rm -f "$tmp"
  printf '%s' "$value"
}

as_owner mkdir -p "$DIR"
printf 'LAST_SEEN=%s\n' "$(now_iso)" | write_file watcher.env

if [[ "$SETUP" -eq 1 ]]; then
  cat <<EOF
The update button is connected: Horde's data folder is $DATA.

To keep it working, run this command every minute as root.
On TrueNAS: System → Advanced Settings → Cron Jobs → Add
  Description:  Horde update button
  Command:      bash $ROOT/scripts/update_watch.sh
  Run As User:  root
  Schedule:     Custom, every minute (* * * * *)
On another Linux host, add this line to root's crontab (sudo crontab -e):
  * * * * * bash $ROOT/scripts/update_watch.sh
EOF
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required (package util-linux)." >&2
  exit 1
fi
# Run as root on a checkout owned by someone else: whatever this run creates
# there is handed back to the owner, so the owner can still run update.sh.
OWNER="$(stat -c %u:%g "$ROOT")"
hand_back() { [[ "$(id -u)" -eq 0 && "${OWNER%%:*}" != "0" ]]; }
mkdir -p "$ROOT/.local"
exec 9>"$ROOT/.local/update-watch.lock"
if hand_back; then
  chown "$OWNER" "$ROOT/.local" "$ROOT/.local/update-watch.lock" 2>/dev/null || true
fi
if ! flock -n 9; then
  exit 0 # an update started by an earlier run is still going
fi

valid_id() { [[ "$1" =~ ^[0-9a-f]{32}$ ]]; }
valid_time() { [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]]; }

# A run that died mid-update (reboot, killed) left "running" behind, or died
# between taking the request (current.env) and writing status.env.
old_id="$(read_key status.env REQUEST_ID)"
taken_id="$(read_key current.env REQUEST_ID)"
valid_id "$taken_id" || taken_id=""
if [[ "$(read_key status.env STATE)" == "running" || (-n "$taken_id" && "$taken_id" != "$old_id") ]]; then
  old_start="$(read_key status.env STARTED_AT)"
  if [[ -n "$taken_id" && "$taken_id" != "$old_id" ]]; then
    old_id="$taken_id"
    old_start=""
  fi
  valid_id "$old_id" || old_id=""
  valid_time "$old_start" || old_start=""
  printf 'STATE=interrupted\nREQUEST_ID=%s\nSTARTED_AT=%s\nFINISHED_AT=%s\n' \
    "$old_id" "$old_start" "$(now_iso)" | write_file status.env
fi

in_dir '[ -e request.env ] || [ -L request.env ]' || exit 0
if ! in_dir 'mv -fT -- request.env current.env' 2>/dev/null; then
  exit 0 # cancelled in the meantime
fi
REQUEST_ID="$(read_key current.env REQUEST_ID)"
if ! valid_id "$REQUEST_ID"; then
  in_dir 'rm -f -- current.env' || true
  echo "Ignoring a malformed update request in $DIR." >&2
  exit 1
fi
REQUESTED_BY="$(read_key current.env REQUESTED_BY)"
REQUESTED_BY="${REQUESTED_BY//[^A-Za-z0-9_.@-]/_}"

STARTED_AT="$(now_iso)"
printf 'STATE=running\nREQUEST_ID=%s\nSTARTED_AT=%s\n' "$REQUEST_ID" "$STARTED_AT" |
  write_file status.env

# Let git work on a checkout owned by someone else, for this run only.
if hand_back; then
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$ROOT"
fi

# The log is written through a pipe into a process running as the owner, which
# creates update.log afresh and, should writing fail, keeps draining the pipe so
# update.sh is never killed by SIGPIPE mid-update. The group runs in a
# subshell, so its exit code comes back through RC_FILE.
RESULT_FILE="$(mktemp)"
RC_FILE="$(mktemp)"
trap 'rm -f "$RESULT_FILE" "$RC_FILE"' EXIT
{
  rc=0
  echo "Update requested by ${REQUESTED_BY:-an administrator}; started $STARTED_AT."
  HORDE_UPDATE_RESULT_FILE="$RESULT_FILE" bash "$ROOT/update.sh" </dev/null 2>&1 || rc=$?
  echo "update.sh finished with exit code $rc."
  echo "$rc" >"$RC_FILE"
} | in_dir 'rm -f -- update.log; dd of=update.log bs=65536 conv=excl oflag=nofollow status=none 2>/dev/null; cat >/dev/null' || true
rc="$(cat "$RC_FILE")"
[[ "$rc" =~ ^[0-9]+$ ]] || rc=1

# Tracked files and every folder above them (a release can add folders).
tracked_paths() {
  local f d
  while IFS= read -r -d '' f; do
    printf '%s\0' "$f"
    d="$f"
    while [[ "$d" == */* ]]; do
      d="${d%/*}"
      printf '%s\0' "$d"
    done
  done < <(git -C "$ROOT" ls-files -z 2>/dev/null)
}
if hand_back; then
  chown -R "$OWNER" "$ROOT/.git" "$ROOT/.local" 2>/dev/null || true
  chown -h "$OWNER" "$ROOT/.env" 2>/dev/null || true
  tracked_paths | sort -zu | (cd "$ROOT" && xargs -0 -r chown -h "$OWNER" 2>/dev/null) || true
fi

STATE="$(horde_env_get "$RESULT_FILE" RESULT)"
case "$STATE" in
  updated | up_to_date | rolled_back | failed) ;;
  *) STATE="$([[ "$rc" -eq 0 ]] && echo updated || echo failed)" ;;
esac
printf 'STATE=%s\nREQUEST_ID=%s\nSTARTED_AT=%s\nFINISHED_AT=%s\nEXIT_CODE=%s\n' \
  "$STATE" "$REQUEST_ID" "$STARTED_AT" "$(now_iso)" "$rc" | write_file status.env

echo "Horde update ($STATE, exit $rc). Log: $DIR/update.log"
[[ "$rc" -eq 0 ]]
