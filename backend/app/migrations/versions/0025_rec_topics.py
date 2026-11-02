"""Topics a user adds to Recommended+ by hand.

``rec_topics``: per user, an ``interest`` (shown more, searched for on YouTube)
or a ``block`` (left out), with how it matches, how strong an interest is, and
when it expires (an expired topic stays listed, switched off). Deleting the
account deletes them. A new table only: ``videos`` is not rebuilt, so the tag
and full-text triggers are untouched.

Revision ID: 0025_rec_topics
Revises: 0024_rec_tuning
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025_rec_topics"
down_revision: str | None = "0024_rec_tuning"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "rec_topics",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("text", sa.String(), nullable=False),
        sa.Column("match", sa.String(), nullable=False),
        sa.Column("strength", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_rec_topics_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("rec_topics", schema=None) as batch_op:
        batch_op.create_index("ix_rec_topics_user_id", ["user_id"], unique=False)


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
