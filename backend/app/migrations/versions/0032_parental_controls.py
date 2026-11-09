"""Parental controls: the channels a member may watch.

Adds the nullable ``users.allowed_channels`` (JSON list of channels; NULL means
no restriction, which every existing account keeps). ``users`` has no triggers.

Revision ID: 0032_parental_controls
Revises: 0031_stream_watch_time
Create Date: 2026-11-09 23:34:52.183238
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0032_parental_controls"
down_revision: str | None = "0031_stream_watch_time"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("allowed_channels", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("allowed_channels")
