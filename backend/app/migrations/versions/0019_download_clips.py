"""Clip downloads: only part of a video, saved as its own library video.

``download_jobs.clip_start_sec`` / ``clip_end_sec`` hold the part to keep, in
seconds from the start of the broadcast; both empty for a normal download.

Plain ADD COLUMNs: ``download_jobs`` is not rebuilt.

Revision ID: 0019_download_clips
Revises: 0018_playlist_entry_links
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019_download_clips"
down_revision: str | None = "0018_playlist_entry_links"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("download_jobs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("clip_start_sec", sa.Float(), nullable=True))
        batch_op.add_column(sa.Column("clip_end_sec", sa.Float(), nullable=True))


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
