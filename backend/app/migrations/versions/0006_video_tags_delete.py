"""Clear a deleted video's ``video_tags`` rows with a trigger.

``video_tags`` relies on ``ON DELETE CASCADE``, which SQLite only applies on a
connection that turned ``PRAGMA foreign_keys`` on. Code that does not (an older
Horde after a rollback, the ``sqlite3`` shell) left the rows behind, and the
tags of a deleted video kept appearing. An ``AFTER DELETE`` trigger keeps the
derived table right on every connection, like the other ``video_tags`` triggers
from ``0005_tags_search``. Existing stray rows are removed by the integrity
check ``init_db`` runs on every start.

Revision ID: 0006_video_tags_delete
Revises: 0005_tags_search
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006_video_tags_delete"
down_revision: str | None = "0005_tags_search"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE TRIGGER trg_videos_tags_delete AFTER DELETE ON videos BEGIN\n"
        "DELETE FROM video_tags WHERE video_id = OLD.id;\nEND"
    )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
