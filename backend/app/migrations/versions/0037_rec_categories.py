"""Recommended: a user's interests as category chips.

``rec_categories``: per user, one row for each interest group made from their
watches (``services/discovery/category_store.py``): its name, centre, YouTube
searches and how much a video's age counts in it. A group that comes back
keeps its row, so a chip keeps its id and name. Deleting the account deletes
them. A new table only: ``videos`` is not rebuilt, so the tag and full-text
triggers are untouched.

Revision ID: 0037_rec_categories
Revises: 0036_video_live_status
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0037_rec_categories"
down_revision: str | None = "0036_video_live_status"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "rec_categories",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("named_by", sa.String(), nullable=False),
        sa.Column("era", sa.String(), nullable=False),
        sa.Column("centroid", sa.LargeBinary(), nullable=False),
        sa.Column("dim", sa.Integer(), nullable=False),
        sa.Column("weight", sa.Float(), nullable=False),
        sa.Column("half_life_days", sa.Float(), nullable=True),
        sa.Column("queries_json", sa.String(), nullable=False),
        sa.Column("seeds_json", sa.String(), nullable=False),
        sa.Column("wanted_at", sa.DateTime(), nullable=True),
        sa.Column("seen_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_rec_categories_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("rec_categories", schema=None) as batch_op:
        batch_op.create_index("ix_rec_categories_user_id", ["user_id"], unique=False)


def downgrade() -> None:
    # The previous revision never reads the table; it is made again on upgrade.
    op.drop_table("rec_categories")
