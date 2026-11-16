"""Count the time spent watching streamed (not downloaded) videos.

``user_watch_time.yt_id``: the YouTube id of a streamed video's row, which has
no ``video_id``; library rows keep it NULL. ``ux_user_watch_time_stream_bucket``
makes a stream's hour one row, as ``ux_user_watch_time_bucket`` does for a
library video. Streaming before this revision was not timed, so nothing is
backfilled.

A plain ADD COLUMN and CREATE INDEX: ``user_watch_time`` is not rebuilt.

Revision ID: 0032_stream_watch_time
Revises: 0031_stream_resume_position
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0032_stream_watch_time"
down_revision: str | None = "0031_stream_resume_position"
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
    # Stream rows have no video to fall back on: they go with the column.
    op.execute("DELETE FROM user_watch_time WHERE yt_id IS NOT NULL")
    with op.batch_alter_table("user_watch_time", schema=None) as batch_op:
        batch_op.drop_index("ux_user_watch_time_stream_bucket")
        batch_op.drop_column("yt_id")
