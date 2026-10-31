"""Saved YouTube comments of library videos.

* ``video_comments``: the top comments of a video and replies to its highest-ranked
  threads. ``video_comments_fts`` (FTS5, external content) indexes their text
  through three triggers, for library search.
* ``video_comment_state``: whether a video's comments were saved, and when to
  fetch them (again).

New tables only; ``videos`` is not touched, so its triggers stay. Without FTS5 the
virtual table and its triggers are skipped with a warning, and search leaves
comments out.

Revision ID: 0023_video_comments
Revises: 0022_ask_knowledge
"""

import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.exc import OperationalError

revision: str = "0023_video_comments"
down_revision: str | None = "0022_ask_knowledge"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger(__name__)


def _create_fts() -> None:
    try:
        op.execute(
            "CREATE VIRTUAL TABLE video_comments_fts USING fts5("
            "text, content = 'video_comments', content_rowid = 'id', "
            "tokenize = 'unicode61')"
        )
    except OperationalError as exc:
        if "fts5" not in str(exc).lower():
            raise
        logger.warning("SQLite has no FTS5 module; search will skip comments")
        return
    op.execute(
        "CREATE TRIGGER trg_video_comments_fts_insert AFTER INSERT ON video_comments "
        "BEGIN\n"
        "INSERT INTO video_comments_fts (rowid, text) VALUES (NEW.id, NEW.text);\nEND"
    )
    op.execute(
        "CREATE TRIGGER trg_video_comments_fts_update AFTER UPDATE OF text "
        "ON video_comments BEGIN\n"
        "INSERT INTO video_comments_fts (video_comments_fts, rowid, text) "
        "VALUES ('delete', OLD.id, OLD.text);\n"
        "INSERT INTO video_comments_fts (rowid, text) VALUES (NEW.id, NEW.text);\nEND"
    )
    op.execute(
        "CREATE TRIGGER trg_video_comments_fts_delete AFTER DELETE ON video_comments "
        "BEGIN\n"
        "INSERT INTO video_comments_fts (video_comments_fts, rowid, text) "
        "VALUES ('delete', OLD.id, OLD.text);\nEND"
    )


def upgrade() -> None:
    op.create_table(
        "video_comments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("video_id", sa.Integer(), nullable=False),
        sa.Column("comment_id", sa.String(), nullable=False),
        sa.Column("parent_comment_id", sa.String(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("author", sa.String(), nullable=True),
        sa.Column("author_is_uploader", sa.Boolean(), nullable=False),
        sa.Column("is_pinned", sa.Boolean(), nullable=False),
        sa.Column("is_hearted", sa.Boolean(), nullable=False),
        sa.Column("like_count", sa.Integer(), nullable=True),
        sa.Column("text", sa.String(), nullable=False),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["video_id"],
            ["videos.id"],
            name="fk_video_comments_video_id_videos",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("video_id", "comment_id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("video_comments", schema=None) as batch_op:
        batch_op.create_index("ix_video_comments_video_id", ["video_id"], unique=False)

    op.create_table(
        "video_comment_state",
        sa.Column("video_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(), nullable=True),
        sa.Column("total_count", sa.Integer(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["video_id"],
            ["videos.id"],
            name="fk_video_comment_state_video_id_videos",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("video_id"),
    )
    with op.batch_alter_table("video_comment_state", schema=None) as batch_op:
        batch_op.create_index(
            "ix_video_comment_state_next_attempt_at",
            ["next_attempt_at"],
            unique=False,
        )

    _create_fts()


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
