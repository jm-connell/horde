#!/usr/bin/env bash
set -e

# Run as the UID/GID that owns the TrueNAS dataset so written files are
# accessible over SMB and not root-owned. Defaults match the common first
# non-system user on TrueNAS SCALE.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

DATA_DIR="${DATA_DIR:-/app/data}"
DOWNLOADS_DIR="${DOWNLOADS_DIR:-/downloads}"

# Create the runtime group/user if they do not already exist.
if ! getent group "$PGID" >/dev/null 2>&1; then
  groupadd -g "$PGID" horde
fi
if ! getent passwd "$PUID" >/dev/null 2>&1; then
  useradd -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin horde
fi

mkdir -p "$DATA_DIR" "$DATA_DIR/thumbnails" "$DOWNLOADS_DIR"

# Own the persistent data dir; skip downloads since the host owns that mount.
chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true

exec gosu "$PUID:$PGID" "$@"
