"""Sharing downloads between accounts.

``users.share_downloads``: whether other accounts on a device may see this
account's offline downloads, and fetch its device-destination downloads from the
server. Everything was shared before, so every existing account (and every new one,
unless it opts out) is on.
A plain ADD COLUMN: ``users`` is not rebuilt.

Revision ID: 0012_share_downloads
Revises: 0011_playlist_owner
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012_share_downloads"
down_revision: str | None = "0011_playlist_owner"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "share_downloads", sa.Boolean(), nullable=False, server_default="1"
            )
        )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
