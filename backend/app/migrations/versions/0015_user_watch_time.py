"""Time spent watching, per user, video and hour.

``user_watch_time``: the seconds each progress save adds to the hour it was
reached in (UTC), plus how many times the video was finished then. The History
stats read it in the viewer's time zone. Deleting a video keeps the rows with
``video_id`` cleared (the channel name is copied onto the row); deleting the
account deletes them. A new table only: ``videos`` is not rebuilt, so the tag and
full-text triggers are untouched. It starts empty: watch time before this
release was never recorded.

Revision ID: 0015_user_watch_time
Revises: 0014_channel_retention
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015_user_watch_time"
down_revision: str | None = "0014_channel_retention"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_watch_time",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("video_id", sa.Integer(), nullable=True),
        sa.Column("channel", sa.String(), nullable=True),
        sa.Column("hour_start", sa.DateTime(), nullable=False),
        sa.Column("seconds", sa.Float(), nullable=False),
        sa.Column("finished", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_user_watch_time_user_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["video_id"],
            ["videos.id"],
            name="fk_user_watch_time_video_id_videos",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("user_watch_time", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_user_watch_time_video_id"), ["video_id"], unique=False
        )
        batch_op.create_index(
            "ux_user_watch_time_bucket",
            ["user_id", "hour_start", "video_id"],
            unique=True,
        )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
