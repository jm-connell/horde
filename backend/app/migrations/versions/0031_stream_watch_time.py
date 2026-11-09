"""Watch time of streamed videos.

``user_watch_time`` only held library videos' time, so watching streams (not
downloaded) added nothing to the History stats. A stream's rows carry its
YouTube id in the new nullable ``yt_id`` column (library rows keep it NULL), with
a unique index per user, hour and stream like the library one. Existing rows are
untouched; ``user_watch_time`` has no triggers.

Revision ID: 0031_stream_watch_time
Revises: 0030_grant_manage_subscriptions
Create Date: 2026-11-09 23:25:15.032006
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0031_stream_watch_time"
down_revision: str | None = "0030_grant_manage_subscriptions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("user_watch_time", schema=None) as batch_op:
        batch_op.add_column(sa.Column("yt_id", sa.String(), nullable=True))
        batch_op.create_index(
            "ux_user_watch_time_stream_bucket",
            ["user_id", "hour_start", "yt_id"],
            unique=True,
        )


def downgrade() -> None:
    with op.batch_alter_table("user_watch_time", schema=None) as batch_op:
        batch_op.drop_index("ux_user_watch_time_stream_bucket")
        batch_op.drop_column("yt_id")
