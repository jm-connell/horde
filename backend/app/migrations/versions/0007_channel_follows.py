"""Followed channels and who queued a download.

* ``channel_follows``: the channels each user follows (the live list reads it).
  ``followed = 0`` is an explicit unfollow, kept so a later download from that
  channel does not follow it again.
* ``download_requesters``: the user who queued a job (no row for automatic jobs
  and every job queued before this revision). A finished library download
  follows its channel for that user. A table of its own, not a column, so
  ``download_jobs`` is not rebuilt.

Revision ID: 0007_channel_follows
Revises: 0006_video_tags_delete
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_channel_follows"
down_revision: str | None = "0006_video_tags_delete"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "channel_follows",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("channel_url", sa.String(), nullable=False),
        sa.Column("channel_name", sa.String(), nullable=True),
        sa.Column("followed", sa.Boolean(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "channel_url", name="uq_channel_follows_user_url"
        ),
    )
    op.create_index(
        "ix_channel_follows_channel_url", "channel_follows", ["channel_url"]
    )
    op.create_index("ix_channel_follows_user_id", "channel_follows", ["user_id"])

    op.create_table(
        "download_requesters",
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["download_jobs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("job_id"),
    )
    op.create_index(
        "ix_download_requesters_user_id", "download_requesters", ["user_id"]
    )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
