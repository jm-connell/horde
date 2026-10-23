"""Per-channel retention rules.

``channel_retention``: one optional rule set per channel (keep the newest N, remove
videos older than D days, remove videos someone finished more than D days ago); a
worker applies the enabled ones and moves what they remove to the trash.
``retention_keeps``: videos restored from the trash, which the rules never touch
again. ``trash_entries.reason`` says why an entry was trashed when it was not by
hand. ``user_video_state.finished_at`` records when a user finished a video
(a half-watch that expired has position 0 as well, so the position cannot tell
them apart); it starts empty, so only videos finished from now on count as watched
for the rules. New tables and plain ADD COLUMNs only: ``videos`` is not rebuilt, so
the tag and full-text triggers are untouched.

Revision ID: 0014_channel_retention
Revises: 0013_download_job_origin
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014_channel_retention"
down_revision: str | None = "0013_download_job_origin"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "channel_retention",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("channel", sa.String(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("keep_latest", sa.Integer(), nullable=True),
        sa.Column("max_age_days", sa.Integer(), nullable=True),
        sa.Column("remove_watched_after_days", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_removed_count", sa.Integer(), nullable=False),
        sa.Column("last_removed_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("channel_retention", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_channel_retention_channel"), ["channel"], unique=True
        )
        batch_op.create_index(
            batch_op.f("ix_channel_retention_enabled"), ["enabled"], unique=False
        )

    op.create_table(
        "retention_keeps",
        sa.Column("video_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["video_id"],
            ["videos.id"],
            name="fk_retention_keeps_video_id_videos",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("video_id"),
    )

    with op.batch_alter_table("trash_entries", schema=None) as batch_op:
        batch_op.add_column(sa.Column("reason", sa.String(), nullable=True))

    with op.batch_alter_table("user_video_state", schema=None) as batch_op:
        batch_op.add_column(sa.Column("finished_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
