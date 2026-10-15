"""Member permissions and per-user AI chat.

* ``users.permissions``: JSON list of granted permission names for members
  (administrators implicitly have everything). Defaults to none here; accounts
  created through the app get the documented default grants.
* ``video_ai_chat_messages.user_id``: a conversation belongs to one user. Existing
  messages keep ``NULL`` until the first administrator is created, who adopts them
  (the same way watch history is adopted).
* ``video_ai_chat`` is dropped: it only carried an ``updated_at`` nothing read, and
  its primary key (one thread per video) cannot represent one thread per user.

Revision ID: 0004_permissions_chat
Revises: 0003_auth
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_permissions_chat"
down_revision: str | None = "0003_auth"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(
            sa.Column("permissions", sa.String(), nullable=False, server_default="[]")
        )
    with op.batch_alter_table("video_ai_chat_messages") as batch:
        batch.add_column(sa.Column("user_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_video_ai_chat_messages_user_id_users",
            "users",
            ["user_id"],
            ["id"],
            ondelete="CASCADE",
        )
        batch.create_index("ix_video_ai_chat_messages_user_id", ["user_id"])
    op.drop_table("video_ai_chat")


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
