"""Profile pictures.

``users.avatar_version``: a new value on each upload (the client's cache key),
NULL when the account has no picture. The image itself is
``DATA_DIR/avatars/{id}_{version}.jpg``.
A plain ADD COLUMN: ``users`` is not rebuilt.

Revision ID: 0009_user_avatars
Revises: 0008_stream_ai
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009_user_avatars"
down_revision: str | None = "0008_stream_ai"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("avatar_version", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("avatar_version")
