"""Videos: whether a library video was a livestream.

``videos.live_status`` holds yt-dlp's value (``not_live``, ``was_live``,
``post_live``, ...), or NULL until known. A past stream (``was_live``) gets
chat replay on the watch page. Filled from the download's info, the metadata
refresh and the chat replay check; here, from the channel video lists
(``channel_catalog_videos``) where they already know the video as a finished
stream or not a stream (what they recorded while a stream was upcoming, live
or still processing says nothing about the library file). A plain
``ADD COLUMN``: ``videos`` is not rebuilt, so its triggers and ``videos_fts``
are untouched.

Revision ID: 0036_video_live_status
Revises: 0035_kb_keep_indexed_videos
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0036_video_live_status"
down_revision: str | None = "0035_kb_keep_indexed_videos"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("videos", sa.Column("live_status", sa.String(), nullable=True))
    op.execute(
        "UPDATE videos SET live_status = ("
        "SELECT c.live_status FROM channel_catalog_videos c "
        "WHERE c.yt_id = videos.youtube_id "
        "AND c.live_status IN ('was_live', 'not_live') LIMIT 1"
        ") WHERE youtube_id IS NOT NULL AND live_status IS NULL"
    )


def downgrade() -> None:
    # The column stays: dropping it would rebuild ``videos`` and lose its
    # triggers, and the previous revision never reads it.
    pass
