#!/bin/sh
# Replace DATA/horde.db with a verified copy of BACKUP. Runs inside a throwaway
# container of the Horde image (see restore_database in update.sh), as root, with
# the app stopped; standalone so it can be tested with plain sh.
#
#   restore_db.sh DATA_DIR BACKUP_FILE TIMESTAMP
#
# The backup is copied next to the live file and checked with PRAGMA
# integrity_check BEFORE anything is touched. The newer database is kept as
# horde.db.pre-rollback-<ts> (hard link, so no copy and no gap), its -wal/-shm
# are moved aside, and only then is the verified copy renamed over horde.db
# (atomic). Any failure exits non-zero having deleted nothing.
set -e

data="$1"
backup="$2"
ts="$3"
[ -d "$data" ] && [ -f "$backup" ] && [ -n "$ts" ] || {
  echo "usage: restore_db.sh DATA_DIR BACKUP_FILE TIMESTAMP" >&2
  exit 2
}

cd "$data"
rm -f horde.db.restoring
cp "$backup" horde.db.restoring
if ! python3 -c '
import sqlite3, sys
c = sqlite3.connect("horde.db.restoring")
sys.exit(0 if c.execute("PRAGMA integrity_check").fetchone()[0] == "ok" else 1)'; then
  echo "backup failed PRAGMA integrity_check; nothing was changed" >&2
  rm -f horde.db.restoring
  exit 1
fi
chown "$(stat -c %u:%g .)" horde.db.restoring

if [ -f horde.db ]; then
  ln horde.db "horde.db.pre-rollback-$ts" 2>/dev/null || cp -p horde.db "horde.db.pre-rollback-$ts"
fi
# The WAL belongs to the database being replaced; applying it to the restored
# file would corrupt it, so it goes aside before the rename.
for ext in wal shm; do
  if [ -f "horde.db-$ext" ]; then
    mv "horde.db-$ext" "horde.db-$ext.pre-rollback-$ts"
  fi
done
mv -f horde.db.restoring horde.db
