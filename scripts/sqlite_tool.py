#!/usr/bin/env python3
"""SQLite helpers for update.sh. Standard library only, so the same file runs on
the host (when python3 exists) or inside the Horde image via
``docker exec -i horde python - <command> ... < scripts/sqlite_tool.py``.

Commands:
  backup DST [SRC]  Consistent online backup (sqlite3 backup API) of SRC into
                    DST, then PRAGMA integrity_check on the copy. SRC defaults
                    to $DATA_DIR/horde.db.
  revision [DB]     Print the Alembic revision (alembic_version.version_num), or
                    "none" when the table is missing (a pre-Alembic database).
"""

from __future__ import annotations

import os
import sqlite3
import sys


def _default_db() -> str:
    return os.path.join(os.environ.get("DATA_DIR", "/app/data"), "horde.db")


def _require_file(path: str) -> None:
    # sqlite3.connect() would silently create an empty database.
    if not os.path.isfile(path):
        raise SystemExit(f"database not found: {path}")


def backup(dst: str, src: str) -> None:
    _require_file(src)
    if os.path.exists(dst):
        os.remove(dst)
    source = sqlite3.connect(src, timeout=30)
    try:
        target = sqlite3.connect(dst)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    check = sqlite3.connect(dst)
    try:
        result = check.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        check.close()
    if result != "ok":
        os.remove(dst)
        raise SystemExit(f"integrity_check failed on the backup: {result}")
    print("ok")


def revision(db: str) -> None:
    """Alembic revision stored in alembic_version ("none" before Alembic)."""
    _require_file(db)
    conn = sqlite3.connect(db, timeout=30)
    try:
        row = conn.execute("SELECT version_num FROM alembic_version").fetchone()
    except sqlite3.OperationalError:
        row = None  # no alembic_version table: a pre-Alembic database
    finally:
        conn.close()
    print(row[0] if row and row[0] else "none")


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "backup":
        backup(argv[1], argv[2] if len(argv) > 2 else _default_db())
        return 0
    if argv and argv[0] == "revision":
        revision(argv[1] if len(argv) > 1 else _default_db())
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
