"""Ask: channel captions as a searchable knowledge base, and Ask conversations.

* ``kb_channels`` / ``kb_videos``: channels whose captions Ask indexes and their
  uploads (with the cleaned captions, compressed). No foreign key to the channel
  catalog: the catalog trims and merges its rows, and captions take hours to fetch.
* ``kb_chunks``: time-aligned passages; ``kb_chunks_fts`` (FTS5, external
  content) indexes their text through three triggers. ``kb_chunk_vectors``: their
  float16 embeddings.
* ``ask_threads`` / ``ask_messages``: each user's saved Ask conversations.
* ``ai_jobs.kb_channel_id`` for the channel embedding job (``ai_jobs`` is rebuilt;
  it has no triggers). ``videos`` is not touched, so its triggers stay.

Without FTS5 the virtual table and its triggers are skipped with a warning, and
Ask reports itself unavailable.

Revision ID: 0022_ask_knowledge
Revises: 0021_youtube_watch_events
"""

import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.exc import OperationalError

revision: str = "0022_ask_knowledge"
down_revision: str | None = "0021_youtube_watch_events"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger(__name__)


def _create_fts() -> None:
    try:
        op.execute(
            "CREATE VIRTUAL TABLE kb_chunks_fts USING fts5("
            "text, content = 'kb_chunks', content_rowid = 'id', "
            "tokenize = 'unicode61')"
        )
    except OperationalError as exc:
        if "fts5" not in str(exc).lower():
            raise
        logger.warning("SQLite has no FTS5 module; Ask will be unavailable")
        return
    op.execute(
        "CREATE TRIGGER trg_kb_chunks_fts_insert AFTER INSERT ON kb_chunks BEGIN\n"
        "INSERT INTO kb_chunks_fts (rowid, text) VALUES (NEW.id, NEW.text);\nEND"
    )
    op.execute(
        "CREATE TRIGGER trg_kb_chunks_fts_update AFTER UPDATE OF text ON kb_chunks "
        "BEGIN\n"
        "INSERT INTO kb_chunks_fts (kb_chunks_fts, rowid, text) "
        "VALUES ('delete', OLD.id, OLD.text);\n"
        "INSERT INTO kb_chunks_fts (rowid, text) VALUES (NEW.id, NEW.text);\nEND"
    )
    op.execute(
        "CREATE TRIGGER trg_kb_chunks_fts_delete AFTER DELETE ON kb_chunks BEGIN\n"
        "INSERT INTO kb_chunks_fts (kb_chunks_fts, rowid, text) "
        "VALUES ('delete', OLD.id, OLD.text);\nEND"
    )


def upgrade() -> None:
    op.create_table(
        "kb_channels",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("channel_url", sa.String(), nullable=False),
        sa.Column("channel_name", sa.String(), nullable=True),
        sa.Column("include_streams", sa.Boolean(), nullable=False),
        sa.Column("max_videos", sa.Integer(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "queued",
                "listing",
                "indexing",
                "ready",
                "paused",
                "error",
                name="kbchannelstatus",
            ),
            nullable=False,
        ),
        sa.Column("embed_model", sa.String(), nullable=True),
        sa.Column("embed_dim", sa.Integer(), nullable=False),
        sa.Column("last_listed_at", sa.DateTime(), nullable=True),
        sa.Column("last_error", sa.String(), nullable=True),
        sa.Column("added_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["added_by"],
            ["users.id"],
            name="fk_kb_channels_added_by_users",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("kb_channels", schema=None) as batch_op:
        batch_op.create_index(
            "ix_kb_channels_channel_url", ["channel_url"], unique=True
        )
        batch_op.create_index("ix_kb_channels_status", ["status"], unique=False)

    op.create_table(
        "kb_videos",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kb_channel_id", sa.Integer(), nullable=False),
        sa.Column("yt_id", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("published_at", sa.String(), nullable=True),
        sa.Column("duration", sa.Float(), nullable=True),
        sa.Column("is_stream", sa.Boolean(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("fetch_status", sa.String(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("caption_auto", sa.Boolean(), nullable=True),
        sa.Column("cues", sa.LargeBinary(), nullable=True),
        sa.Column("embedded_model", sa.String(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["kb_channel_id"],
            ["kb_channels.id"],
            name="fk_kb_videos_kb_channel_id_kb_channels",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("kb_channel_id", "yt_id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("kb_videos", schema=None) as batch_op:
        batch_op.create_index(
            "ix_kb_videos_channel_status",
            ["kb_channel_id", "fetch_status"],
            unique=False,
        )
        batch_op.create_index(
            "ix_kb_videos_kb_channel_id", ["kb_channel_id"], unique=False
        )
        batch_op.create_index("ix_kb_videos_yt_id", ["yt_id"], unique=False)

    op.create_table(
        "kb_chunks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kb_video_id", sa.Integer(), nullable=False),
        sa.Column("kb_channel_id", sa.Integer(), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("start_sec", sa.Float(), nullable=False),
        sa.Column("end_sec", sa.Float(), nullable=False),
        sa.Column("text", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["kb_channel_id"],
            ["kb_channels.id"],
            name="fk_kb_chunks_kb_channel_id_kb_channels",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["kb_video_id"],
            ["kb_videos.id"],
            name="fk_kb_chunks_kb_video_id_kb_videos",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("kb_chunks", schema=None) as batch_op:
        batch_op.create_index(
            "ix_kb_chunks_kb_channel_id", ["kb_channel_id"], unique=False
        )
        batch_op.create_index("ix_kb_chunks_kb_video_id", ["kb_video_id"], unique=False)

    op.create_table(
        "kb_chunk_vectors",
        sa.Column("chunk_id", sa.Integer(), nullable=False),
        sa.Column("vector", sa.LargeBinary(), nullable=False),
        sa.ForeignKeyConstraint(
            ["chunk_id"],
            ["kb_chunks.id"],
            name="fk_kb_chunk_vectors_chunk_id_kb_chunks",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("chunk_id"),
    )

    op.create_table(
        "ask_threads",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_ask_threads_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("ask_threads", schema=None) as batch_op:
        batch_op.create_index("ix_ask_threads_updated_at", ["updated_at"], unique=False)
        batch_op.create_index("ix_ask_threads_user_id", ["user_id"], unique=False)

    op.create_table(
        "ask_messages",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("thread_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("content", sa.String(), nullable=False),
        sa.Column("sources", sa.String(), nullable=True),
        sa.Column("cost", sa.Float(), nullable=True),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["thread_id"],
            ["ask_threads.id"],
            name="fk_ask_messages_thread_id_ask_threads",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("ask_messages", schema=None) as batch_op:
        batch_op.create_index("ix_ask_messages_thread_id", ["thread_id"], unique=False)

    with op.batch_alter_table("ai_jobs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("kb_channel_id", sa.Integer(), nullable=True))
        batch_op.create_index(
            "ix_ai_jobs_kb_channel_id", ["kb_channel_id"], unique=False
        )
        batch_op.create_foreign_key(
            "fk_ai_jobs_kb_channel_id_kb_channels",
            "kb_channels",
            ["kb_channel_id"],
            ["id"],
            ondelete="CASCADE",
        )

    _create_fts()


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
