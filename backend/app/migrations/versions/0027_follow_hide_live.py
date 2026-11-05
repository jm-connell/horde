"""Hide a followed channel's live streams without unfollowing it.

``channel_follows.hide_live``: the channel stays followed (and in Recommended),
but its broadcasts leave the Live list and the feeds. False for existing rows.

A plain ADD COLUMN: ``channel_follows`` is not rebuilt.

Revision ID: 0027_follow_hide_live
Revises: 0026_rec_algorithms
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0027_follow_hide_live"
down_revision: str | None = "0026_rec_algorithms"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("channel_follows", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("hide_live", sa.Boolean(), nullable=False, server_default="0")
        )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
