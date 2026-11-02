"""Saved, and optionally shared, Recommended+ algorithms.

``rec_algorithms``: a named ``Tuning`` per owner (names unique per owner); a
shared one is offered to every account. Deleting the account deletes its
algorithms; people who ranked with one keep its last values. A new table only:
``videos`` is not rebuilt, so the tag and full-text triggers are untouched.

Revision ID: 0026_rec_algorithms
Revises: 0025_rec_topics
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026_rec_algorithms"
down_revision: str | None = "0025_rec_topics"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "rec_algorithms",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("shared", sa.Boolean(), nullable=False),
        sa.Column("tuning_json", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_rec_algorithms_owner_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", "name", name="uq_rec_algorithms_owner_name"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("rec_algorithms", schema=None) as batch_op:
        batch_op.create_index("ix_rec_algorithms_owner_id", ["owner_id"], unique=False)


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
