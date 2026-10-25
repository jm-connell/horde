"""Playlist entries that are streamed rather than downloaded.

``playlist_items.video_id`` becomes nullable with ``ON DELETE SET NULL``: an
entry without a library video is played as a stream. New columns hold what to
stream (``youtube_id``, ``url``) and what to show (``title``, ``channel``,
``channel_url``, ``duration_sec``). Existing entries get that snapshot from their
video now, so they keep it if the video is later deleted from the server.

Only ``playlist_items`` is rebuilt (to change the foreign key, and with
AUTOINCREMENT, because entry ids are now handed to clients and must not be
reused); nothing depends on it, so the ``videos`` triggers are untouched.

Revision ID: 0017_playlist_stream_entries
Revises: 0016_two_factor
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017_playlist_stream_entries"
down_revision: str | None = "0016_two_factor"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_FK = "fk_playlist_items_video_id_videos"
_SNAPSHOT = ("youtube_id", "url", "title", "channel", "channel_url", "duration_sec")


def upgrade() -> None:
    with op.batch_alter_table(
        "playlist_items",
        recreate="always",
        table_kwargs={"sqlite_autoincrement": True},
    ) as batch:
        for column in _SNAPSHOT:
            kind = sa.Float() if column == "duration_sec" else sa.String()
            batch.add_column(sa.Column(column, kind, nullable=True))
        batch.alter_column("video_id", existing_type=sa.Integer(), nullable=True)
        batch.drop_constraint(_FK, type_="foreignkey")
        batch.create_foreign_key(
            _FK, "videos", ["video_id"], ["id"], ondelete="SET NULL"
        )
        batch.create_index("ix_playlist_items_youtube_id", ["youtube_id"])
    op.execute(
        "UPDATE playlist_items SET "
        "youtube_id = (SELECT youtube_id FROM videos WHERE videos.id = video_id), "
        "url = (SELECT source_url FROM videos WHERE videos.id = video_id), "
        "title = (SELECT title FROM videos WHERE videos.id = video_id), "
        "channel = (SELECT channel FROM videos WHERE videos.id = video_id), "
        "channel_url = (SELECT channel_url FROM videos WHERE videos.id = video_id), "
        "duration_sec = (SELECT duration_sec FROM videos WHERE videos.id = video_id)"
    )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
