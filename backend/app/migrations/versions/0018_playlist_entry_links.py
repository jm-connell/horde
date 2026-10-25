"""Keep only http(s) links on playlist entries.

0017 copied every video's ``source_url`` into its entries, but only an http(s)
link can be streamed or downloaded again (``playlist_entries.snapshot`` keeps
only those). A non-http link (a local import path) made "Download all" offer a
video it could not queue. Data only: no schema change.

Revision ID: 0018_playlist_entry_links
Revises: 0017_playlist_stream_entries
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0018_playlist_entry_links"
down_revision: str | None = "0017_playlist_stream_entries"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "UPDATE playlist_items SET url = NULL WHERE url IS NOT NULL "
        "AND substr(url, 1, 7) != 'http://' AND substr(url, 1, 8) != 'https://'"
    )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
