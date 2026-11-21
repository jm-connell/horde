"""Ask: SponsorBlock segments per indexed video.

Adds the nullable ``kb_videos.sponsor_segments`` (JSON ``[[start, end,
category], ...]``) and ``kb_videos.sponsor_checked_at`` (NULL = not asked yet,
so every existing video is backfilled), plus an index on the latter for the
worker's "next video to ask" query. Plain ADD COLUMN and CREATE INDEX:
``kb_videos`` is not rebuilt and has no triggers.

Revision ID: 0034_kb_sponsor_segments
Revises: 0033_parental_controls
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0034_kb_sponsor_segments"
down_revision: str | None = "0033_parental_controls"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("kb_videos", schema=None) as batch_op:
        batch_op.add_column(sa.Column("sponsor_segments", sa.String(), nullable=True))
        batch_op.add_column(
            sa.Column("sponsor_checked_at", sa.DateTime(), nullable=True)
        )
        batch_op.create_index(
            "ix_kb_videos_sponsor_checked_at", ["sponsor_checked_at"], unique=False
        )


def downgrade() -> None:
    with op.batch_alter_table("kb_videos", schema=None) as batch_op:
        batch_op.drop_index("ix_kb_videos_sponsor_checked_at")
        batch_op.drop_column("sponsor_checked_at")
        batch_op.drop_column("sponsor_segments")
