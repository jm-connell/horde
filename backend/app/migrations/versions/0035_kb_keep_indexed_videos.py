"""Ask: keep what large channels already have indexed.

Ask now indexes a channel's newest uploads up to a limit (the app-wide
``ask_max_videos``, 500 unless changed, or the channel's own
``kb_channels.max_videos``) and deletes what lies beyond it. Until now a
channel had no limit, so one that already holds more than 500 uploads gets its
current count as its own limit: upgrading deletes nothing, and lowering the
limit stays a choice. Data only; no schema change.

Revision ID: 0035_kb_keep_indexed_videos
Revises: 0034_kb_sponsor_segments
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0035_kb_keep_indexed_videos"
down_revision: str | None = "0034_kb_sponsor_segments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_DEFAULT_LIMIT = 500
_MAX_LIMIT = 5000


def upgrade() -> None:
    conn = op.get_bind()
    # Uploads and past live streams are limited separately: the larger counts.
    rows = conn.execute(
        sa.text(
            "SELECT v.kb_channel_id, COUNT(*) FROM kb_videos v "
            "JOIN kb_channels c ON c.id = v.kb_channel_id "
            "WHERE c.max_videos IS NULL GROUP BY v.kb_channel_id, v.is_stream"
        )
    ).fetchall()
    largest: dict[int, int] = {}
    for channel_id, count in rows:
        largest[channel_id] = max(largest.get(channel_id, 0), count)
    for channel_id, count in largest.items():
        if count > _DEFAULT_LIMIT:
            conn.execute(
                sa.text("UPDATE kb_channels SET max_videos = :n WHERE id = :id"),
                {"n": min(count, _MAX_LIMIT), "id": channel_id},
            )


def downgrade() -> None:
    # The limits stay: the previous revision never reads them.
    pass
