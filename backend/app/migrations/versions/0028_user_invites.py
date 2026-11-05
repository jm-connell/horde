"""One-time invite links for new member accounts.

``user_invites``: the SHA-256 of a link's token, who it is for, the permissions
the new account gets, when it expires and who used it. Deleting the account that
made or used an invite keeps the row (the id becomes NULL). A new table only:
``videos`` is not rebuilt, so the tag and full-text triggers are untouched.

Revision ID: 0028_user_invites
Revises: 0027_follow_hide_live
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0028_user_invites"
down_revision: str | None = "0027_follow_hide_live"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_invites",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("permissions", sa.String(), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column("used_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name="fk_user_invites_created_by_users",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["used_by"],
            ["users.id"],
            name="fk_user_invites_used_by_users",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("user_invites", schema=None) as batch_op:
        batch_op.create_index("ix_user_invites_token_hash", ["token_hash"], unique=True)


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
