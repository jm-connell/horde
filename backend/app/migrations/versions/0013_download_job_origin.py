"""Who queued a download job.

``download_jobs.origin``: ``manual`` (a person), ``channel_autodownload`` or
``playlist_sync``. Notifications use it to tell watched downloads from unattended
ones. Existing jobs are all ``manual``. A plain ADD COLUMN: ``download_jobs`` is
not rebuilt.

Revision ID: 0013_download_job_origin
Revises: 0012_share_downloads
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013_download_job_origin"
down_revision: str | None = "0012_share_downloads"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("download_jobs", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "origin",
                sa.String(),
                nullable=False,
                server_default="manual",
            )
        )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
