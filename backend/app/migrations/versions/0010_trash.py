"""Trash for deleted videos.

``trash_entries``: one tombstone per video a user deleted. ``snapshot_json`` holds
the rows a restore puts back (video, AI data, playlist places, watch state),
``files_json`` the files moved into ``DOWNLOADS_DIR/.horde-trash`` and
``DATA_DIR/trash``. A new table only: ``videos`` is not rebuilt, so the tag and
full-text triggers are untouched.

Revision ID: 0010_trash
Revises: 0009_user_avatars
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010_trash"
down_revision: str | None = "0009_user_avatars"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "trash_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("video_id", sa.Integer(), nullable=False),
        sa.Column("youtube_id", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("channel", sa.String(), nullable=True),
        sa.Column("relative_path", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("trashed_at", sa.DateTime(), nullable=False),
        sa.Column("trashed_by_user_id", sa.Integer(), nullable=True),
        sa.Column("files_json", sa.String(), nullable=False),
        sa.Column("snapshot_json", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["trashed_by_user_id"],
            ["users.id"],
            name="fk_trash_entries_trashed_by_user_id_users",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("trash_entries", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_trash_entries_trashed_at"), ["trashed_at"], unique=False
        )
        batch_op.create_index(
            batch_op.f("ix_trash_entries_youtube_id"), ["youtube_id"], unique=False
        )


def downgrade() -> None:
    with op.batch_alter_table("trash_entries", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_trash_entries_youtube_id"))
        batch_op.drop_index(batch_op.f("ix_trash_entries_trashed_at"))

    op.drop_table("trash_entries")
