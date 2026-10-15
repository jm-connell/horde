#!/usr/bin/env bash
set -euo pipefail

# Run as the UID/GID that owns the TrueNAS dataset so written files are
# accessible over SMB and not root-owned. Defaults match the common first
# non-system user on TrueNAS SCALE.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

DATA_DIR="${DATA_DIR:-/app/data}"
DOWNLOADS_DIR="${DOWNLOADS_DIR:-/downloads}"
YTDLP_PYLIB="${YTDLP_PYLIB:-$DATA_DIR/pylib}"
BUILD_INFO="${BUILD_INFO_FILE:-/app/BUILD_INFO}"

log() {
  echo "horde-entrypoint: $*"
}

if ! [[ "$PUID" =~ ^[0-9]+$ && "$PGID" =~ ^[0-9]+$ ]]; then
  log "PUID and PGID must be numeric (got PUID='$PUID' PGID='$PGID')." >&2
  exit 1
fi

# Running the app as root makes every downloaded file root-owned on the host
# and removes a layer of containment. Allow it only when explicitly requested.
if [[ "$PUID" -eq 0 || "$PGID" -eq 0 ]]; then
  if [[ "${HORDE_ALLOW_ROOT:-}" != "1" ]]; then
    log "refusing to run as root (PUID=$PUID PGID=$PGID)." >&2
    log "Set PUID/PGID to the owner of your media dataset (see .env.example)," >&2
    log "or set HORDE_ALLOW_ROOT=1 if you really want the app to run as root." >&2
    exit 1
  fi
  log "WARNING: HORDE_ALLOW_ROOT=1, running the app as root."
fi

# Create the runtime group/user if they do not already exist.
if ! getent group "$PGID" >/dev/null 2>&1; then
  groupadd -g "$PGID" horde
fi
if ! getent passwd "$PUID" >/dev/null 2>&1; then
  useradd -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin horde
fi

mkdir -p "$DATA_DIR" "$DOWNLOADS_DIR"

# Own the persistent data dir, but only walk it when something is wrong: the
# top-level owner differs (first start, or PUID/PGID changed) or a cheap probe
# finds any file inside with a different owner or group (for example a horde.db
# restored as root by a rollback, which would leave the app with a read-only
# database). A recursive chown on every start is slow on large thumbnail
# caches. Downloads are left alone: the host owns that mount.
current_owner="$(stat -c '%u:%g' "$DATA_DIR")"
# `|| true`: a file vanishing mid-walk makes find exit non-zero; an empty result
# then simply means "nothing found" and must not abort the start.
stray="$(find "$DATA_DIR" -xdev \( ! -user "$PUID" -o ! -group "$PGID" \) -print -quit 2>/dev/null || true)"
if [[ "$current_owner" != "$PUID:$PGID" || -n "$stray" ]]; then
  log "chown -R $PUID:$PGID $DATA_DIR (top level was $current_owner${stray:+, e.g. $stray})"
  if ! chown -R "$PUID:$PGID" "$DATA_DIR"; then
    log "WARNING: could not chown $DATA_DIR; the app may be unable to write there." >&2
  fi
fi
# Subdirectories are created as the runtime user so they never end up root-owned.
if ! gosu "$PUID:$PGID" mkdir -p "$DATA_DIR/thumbnails"; then
  log "WARNING: could not create $DATA_DIR/thumbnails as $PUID:$PGID." >&2
fi

# Opt-in: install the newest yt-dlp into the data volume so a YouTube breakage
# can be fixed with a container restart instead of an image rebuild. Failure is
# never fatal: the yt-dlp baked into the image keeps working.
ytdlp_version() {
  # Print the yt-dlp version found with the given PYTHONPATH prefix ("" = baked only).
  python -I -c '
import importlib.metadata as m, sys
sys.path[:0] = [p for p in sys.argv[1:] if p]
print(m.version("yt-dlp"))' "$1" 2>/dev/null || true
}

version_lt() {
  # True when dotted-numeric version $1 is older than $2.
  python -c '
import re, sys
key = lambda v: tuple(int(n) for n in re.findall(r"\d+", v)[:4])
sys.exit(0 if key(sys.argv[1]) < key(sys.argv[2]) else 1)' "$1" "$2"
}

update_ytdlp() {
  local staging="${YTDLP_PYLIB}.new" baked have fresh
  local limit="${YTDLP_UPDATE_TIMEOUT_SEC:-45}"
  baked="$(ytdlp_version "")"
  rm -rf "$staging"
  log "YTDLP_AUTO_UPDATE=1: checking for a newer yt-dlp (baked: ${baked:-unknown}, ${limit}s limit)"
  # The limit is part of the start-up time `update.sh` waits for, so it stays
  # well under HORDE_HEALTH_TIMEOUT_SEC. Wheels only: never run a build script.
  if gosu "$PUID:$PGID" env HOME=/tmp timeout "$limit" \
       pip install --quiet --disable-pip-version-check --upgrade --no-deps \
       --only-binary=:all: --retries 1 --timeout 15 \
       --target "$staging" yt-dlp; then
    fresh="$(ytdlp_version "$staging")"
    if [[ -n "$baked" && -n "$fresh" ]] && version_lt "$fresh" "$baked"; then
      log "ignoring yt-dlp $fresh from PyPI: older than the baked $baked"
      rm -rf "$staging"
    else
      rm -rf "$YTDLP_PYLIB"
      mv "$staging" "$YTDLP_PYLIB"
      log "yt-dlp from $YTDLP_PYLIB: ${fresh:-unknown}"
      return 0
    fi
  else
    log "WARNING: yt-dlp update failed (offline?); continuing." >&2
    rm -rf "$staging"
  fi
  # A leftover copy older than the one baked into a newer image would shadow it.
  if [[ -d "$YTDLP_PYLIB" ]]; then
    have="$(ytdlp_version "$YTDLP_PYLIB")"
    if [[ -n "$baked" && -n "$have" ]] && version_lt "$have" "$baked"; then
      log "discarding stale $YTDLP_PYLIB ($have is older than baked $baked)"
      rm -rf "$YTDLP_PYLIB"
    fi
  fi
  return 0
}

if [[ "${YTDLP_AUTO_UPDATE:-}" == "1" ]]; then
  update_ytdlp
  if [[ -d "$YTDLP_PYLIB" ]]; then
    export PYTHONPATH="$YTDLP_PYLIB${PYTHONPATH:+:$PYTHONPATH}"
  fi
fi

log "uid=$PUID gid=$PGID data=$DATA_DIR downloads=$DOWNLOADS_DIR"
if [[ -r "$BUILD_INFO" ]]; then
  while IFS= read -r line; do
    log "build: $line"
  done < "$BUILD_INFO"
fi

exec gosu "$PUID:$PGID" "$@"
