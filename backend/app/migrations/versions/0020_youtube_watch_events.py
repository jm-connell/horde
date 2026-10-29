"""YouTube watch history imported from Google Takeout, per user.

``youtube_watch_events``: one row per view (user, YouTube id, time watched),
unique on those three so importing an overlapping export adds only new views.
Kept apart from ``user_video_state``: these views never show in History.
Deleting the account deletes them. A new table only: ``videos`` is not rebuilt,
so the tag and full-text triggers are untouched.

Revision ID: 0020_youtube_watch_events
Revises: 0019_download_clips
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020_youtube_watch_events"
down_revision: str | None = "0019_download_clips"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "youtube_watch_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("yt_id", sa.String(), nullable=False),
        sa.Column("watched_at", sa.DateTime(), nullable=False),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("channel", sa.String(), nullable=True),
        sa.Column("channel_url", sa.String(), nullable=True),
        sa.Column("imported_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_youtube_watch_events_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "yt_id", "watched_at", name="uq_youtube_watch_events_view"
        ),
    )
    with op.batch_alter_table("youtube_watch_events", schema=None) as batch_op:
        batch_op.create_index(
            "ix_youtube_watch_events_user_watched",
            ["user_id", "watched_at"],
            unique=False,
        )
        batch_op.create_index(
            "ix_youtube_watch_events_user_yt", ["user_id", "yt_id"], unique=False
        )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
