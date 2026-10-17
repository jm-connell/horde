"""AI results for streamed videos that were not downloaded.

``stream_ai_state`` keeps the summary, AI chapters and fetched captions of a
streamed YouTube video (one row per YouTube id) and ``stream_ai_chat_messages``
each user's chat about it. Downloading the video moves both onto the library
video; rows nobody opened for ``HORDE_STREAM_AI_RETENTION_DAYS`` are deleted.

Revision ID: 0007_stream_ai
Revises: 0006_video_tags_delete
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_stream_ai"
down_revision: str | None = "0006_video_tags_delete"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "stream_ai_state",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("youtube_id", sa.String(), nullable=False),
        sa.Column("source_url", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("channel", sa.String(), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("duration_sec", sa.Float(), nullable=True),
        sa.Column("captions_vtt", sa.String(), nullable=True),
        sa.Column("summary", sa.String(), nullable=True),
        sa.Column("summary_length", sa.String(), nullable=True),
        sa.Column("summary_cost", sa.Float(), nullable=True),
        sa.Column("summary_model", sa.String(), nullable=True),
        sa.Column("chapters", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("stream_ai_state", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_stream_ai_state_last_used_at"),
            ["last_used_at"],
            unique=False,
        )
        batch_op.create_index(
            batch_op.f("ix_stream_ai_state_youtube_id"), ["youtube_id"], unique=True
        )

    op.create_table(
        "stream_ai_chat_messages",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("stream_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("content", sa.String(), nullable=False),
        sa.Column("cost", sa.Float(), nullable=True),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["stream_id"], ["stream_ai_state.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("stream_ai_chat_messages", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_stream_ai_chat_messages_stream_id"),
            ["stream_id"],
            unique=False,
        )
        batch_op.create_index(
            batch_op.f("ix_stream_ai_chat_messages_user_id"), ["user_id"], unique=False
        )


def downgrade() -> None:
    with op.batch_alter_table("stream_ai_chat_messages", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_stream_ai_chat_messages_user_id"))
        batch_op.drop_index(batch_op.f("ix_stream_ai_chat_messages_stream_id"))

    op.drop_table("stream_ai_chat_messages")
    with op.batch_alter_table("stream_ai_state", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_stream_ai_state_youtube_id"))
        batch_op.drop_index(batch_op.f("ix_stream_ai_state_last_used_at"))

    op.drop_table("stream_ai_state")
