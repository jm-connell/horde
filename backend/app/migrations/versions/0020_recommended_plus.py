"""Recommended+: discovered videos, stream history and recommendation feedback.

New tables only (nothing is rebuilt, so the tag and full-text triggers are
untouched):

* ``user_stream_state``: what each user streamed without downloading (taste for
  recommendations, and what to leave out of them).
* ``discovery_videos`` / ``discovery_hits``: YouTube videos the Recommended+
  gatherer found outside the library and the catalogs, and for whom and why.
* ``discovery_state``: per user, when the gatherer last ran and what it asked.
* ``rec_feedback`` / ``rec_impressions``: "not interested" and "don't recommend
  this channel", and how often a recommendation was shown without being watched.

All start empty.

Revision ID: 0020_recommended_plus
Revises: 0019_download_clips
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020_recommended_plus"
down_revision: str | None = "0019_download_clips"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "discovery_videos",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("yt_id", sa.String(), nullable=False),
        sa.Column("url", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("channel", sa.String(), nullable=True),
        sa.Column("channel_url", sa.String(), nullable=True),
        sa.Column("duration", sa.Float(), nullable=True),
        sa.Column("view_count", sa.Integer(), nullable=True),
        sa.Column("published_at", sa.String(), nullable=True),
        sa.Column("published_label", sa.String(), nullable=True),
        sa.Column("thumbnail_url", sa.String(), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("live_status", sa.String(), nullable=True),
        sa.Column("found_at", sa.DateTime(), nullable=False),
        sa.Column("embed_model", sa.String(), nullable=False),
        sa.Column("embed_dim", sa.Integer(), nullable=False),
        sa.Column("vector", sa.LargeBinary(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("discovery_videos", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_discovery_videos_channel_url"), ["channel_url"], unique=False
        )
        batch_op.create_index(
            batch_op.f("ix_discovery_videos_yt_id"), ["yt_id"], unique=True
        )

    op.create_table(
        "discovery_hits",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("discovery_video_id", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("seed", sa.String(), nullable=False),
        sa.Column("seed_title", sa.String(), nullable=True),
        sa.Column("era", sa.String(), nullable=False),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column("found_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["discovery_video_id"],
            ["discovery_videos.id"],
            name="fk_discovery_hits_discovery_video_id_discovery_videos",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_discovery_hits_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "discovery_video_id", "source"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("discovery_hits", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_discovery_hits_discovery_video_id"),
            ["discovery_video_id"],
            unique=False,
        )
        batch_op.create_index(
            batch_op.f("ix_discovery_hits_user_id"), ["user_id"], unique=False
        )

    op.create_table(
        "discovery_state",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("last_viewed_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("requested_at", sa.DateTime(), nullable=True),
        sa.Column("last_error", sa.String(), nullable=True),
        sa.Column("asked_json", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_discovery_state_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.create_table(
        "rec_feedback",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_rec_feedback_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "kind", "key", name="uq_rec_feedback_user_kind_key"
        ),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("rec_feedback", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_rec_feedback_user_id"), ["user_id"], unique=False
        )

    op.create_table(
        "rec_impressions",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("shown_count", sa.Integer(), nullable=False),
        sa.Column("last_shown_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_rec_impressions_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", "key"),
    )
    op.create_table(
        "user_stream_state",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("yt_id", sa.String(), nullable=False),
        sa.Column("url", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("channel", sa.String(), nullable=True),
        sa.Column("channel_url", sa.String(), nullable=True),
        sa.Column("duration_sec", sa.Float(), nullable=True),
        sa.Column("watched_sec", sa.Float(), nullable=False),
        sa.Column("last_watched_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_user_stream_state_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", "yt_id"),
    )
    with op.batch_alter_table("user_stream_state", schema=None) as batch_op:
        batch_op.create_index(
            "ix_user_stream_state_user_watched",
            ["user_id", "last_watched_at"],
            unique=False,
        )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
