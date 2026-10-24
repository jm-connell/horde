"""Playlists belong to a user and are App-wide or Private.

* ``playlists.owner_user_id``: who made the playlist (FK ``users``, CASCADE: a
  deleted account takes its private playlists with it; its public ones are handed
  on by the account deletion service before that). Existing playlists were shared,
  so they all become the first administrator's, as ``public``: nothing changes
  for anyone. NULL when there is no administrator yet (an install from before
  accounts); the first administrator adopts those when the account is created.
* ``playlists.visibility``: ``public`` or ``private``.

``playlists`` is rebuilt (batch mode); the runner has ``foreign_keys`` off for the
migration, so ``playlist_items`` and ``download_jobs`` keep their rows.

Revision ID: 0011_playlist_owner
Revises: 0010_trash
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011_playlist_owner"
down_revision: str | None = "0010_trash"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("playlists", schema=None) as batch_op:
        batch_op.add_column(sa.Column("owner_user_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column(
                "visibility",
                sa.Enum("public", "private", name="playlistvisibility"),
                nullable=False,
                server_default="public",
            )
        )
        batch_op.create_index(
            batch_op.f("ix_playlists_owner_user_id"), ["owner_user_id"], unique=False
        )
        batch_op.create_foreign_key(
            "fk_playlists_owner_user_id_users",
            "users",
            ["owner_user_id"],
            ["id"],
            ondelete="CASCADE",
        )
    # The first administrator is the identity that adopts shared data elsewhere too.
    op.execute(
        "UPDATE playlists SET owner_user_id = ("
        "SELECT id FROM users WHERE is_admin = 1 AND disabled = 0 "
        "ORDER BY id LIMIT 1)"
    )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
