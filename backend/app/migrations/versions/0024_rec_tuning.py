"""Recommended+ settings per user.

* ``user_settings.rec_tuning_json``: the preset or own values a user ranks
  Recommended+ with (``services/discovery/tuning.py``). Empty means Balanced.

A new nullable column only; no table that carries triggers is rebuilt.

Revision ID: 0024_rec_tuning
Revises: 0023_video_comments
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0024_rec_tuning"
down_revision: str | None = "0023_video_comments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("user_settings", schema=None) as batch_op:
        batch_op.add_column(sa.Column("rec_tuning_json", sa.String(), nullable=True))


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
