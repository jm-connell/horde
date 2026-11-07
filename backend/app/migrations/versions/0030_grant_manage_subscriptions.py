"""Grant the new ``manage_subscriptions`` permission to existing members.

Subscribing and unsubscribing (``PUT`` / ``DELETE /api/follows``, Takeout's
subscriptions, being subscribed by a finished download) now need
``manage_subscriptions``, which new accounts get by default. Accounts and
unused invites made before it existed hold a stored list without it, and would
silently lose what they could always do, so it is added to every member's
``users.permissions`` and every invite's ``user_invites.permissions``.
Administrators have every permission already. No table changes shape, so the
tag and full-text triggers are untouched.

Revision ID: 0030_grant_manage_subscriptions
Revises: 0029_video_chats_to_ask
"""

import json
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0030_grant_manage_subscriptions"
down_revision: str | None = "0029_video_chats_to_ask"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PERMISSION = "manage_subscriptions"


def _with_grant(raw: str | None) -> str | None:
    """The stored JSON list with the grant added; None when it needs no change."""
    try:
        granted = json.loads(raw or "[]")
    except ValueError:
        granted = []
    if not isinstance(granted, list):
        granted = []
    if PERMISSION in granted:
        return None
    return json.dumps([*granted, PERMISSION])


def _grant(conn: sa.Connection, table: sa.TableClause, *where: Any) -> None:
    rows = conn.execute(sa.select(table.c.id, table.c.permissions).where(*where)).all()
    for row_id, raw in rows:
        updated = _with_grant(raw)
        if updated is not None:
            conn.execute(
                table.update().where(table.c.id == row_id).values(permissions=updated)
            )


def upgrade() -> None:
    conn = op.get_bind()
    users = sa.table(
        "users", sa.column("id"), sa.column("permissions"), sa.column("is_admin")
    )
    invites = sa.table("user_invites", sa.column("id"), sa.column("permissions"))
    _grant(conn, users, users.c.is_admin == sa.false())
    _grant(conn, invites)


def downgrade() -> None:
    # The grant stays: an older version ignores a permission it does not know,
    # and which members held it before cannot be told apart afterwards.
    pass
