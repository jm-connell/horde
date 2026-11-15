"""Remember where a streamed (not downloaded) video was left, to resume it.

``user_stream_state.position_sec``: the last position the player reported, 0
once the stream played to the end. ``watched_sec`` (the furthest point reached)
stays as it is for Recommended. Existing unfinished rows start from their
furthest point, the best guess at where they were left.

A plain ADD COLUMN: ``user_stream_state`` is not rebuilt.

Revision ID: 0031_stream_resume_position
Revises: 0030_grant_manage_subscriptions
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0031_stream_resume_position"
down_revision: str | None = "0030_grant_manage_subscriptions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("user_stream_state", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("position_sec", sa.Float(), nullable=False, server_default="0")
        )
    op.execute(
        "UPDATE user_stream_state SET position_sec = watched_sec "
        "WHERE finished_at IS NULL"
    )


def downgrade() -> None:
    with op.batch_alter_table("user_stream_state", schema=None) as batch_op:
        batch_op.drop_column("position_sec")
