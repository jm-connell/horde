"""Copy each user's chat about each video into an Ask conversation.

Chat about a video moved into Ask (``api/ask.py``, ADR 0029), so the per-video
chats (``video_ai_chat_messages`` for library videos, ``stream_ai_chat_messages``
for streams) are copied into ``ask_threads`` / ``ask_messages``: one
conversation per user and video, titled with the video and scoped to it, so it
can be continued. Rows without an owner (from before accounts) go to the first
administrator when there is one; otherwise the bootstrap moves them later
(``knowledge.threads.adopt_video_chats``). The old rows are left in place, and
the copies are marked in their scope so a downgrade removes exactly them. No
table changes shape, so the tag and full-text triggers are untouched.

Revision ID: 0029_video_chats_to_ask
Revises: 0028_user_invites
"""

import json
from collections.abc import Sequence
from typing import Any
from urllib.parse import parse_qs, urlparse

import sqlalchemy as sa
from alembic import op

revision: str = "0029_video_chats_to_ask"
down_revision: str | None = "0028_user_invites"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: In ``ask_threads.scope``: marks a conversation this revision made.
_MARK = "imported"
_MARK_VALUE = "video_chat"
_TITLE_CHARS = 120

_LIBRARY = sa.text(
    "SELECT COALESCE(m.user_id, :admin) AS uid, m.video_id AS key, m.role, "
    "m.content, m.cost, m.model, m.created_at, v.title, v.source_url, "
    "NULL AS youtube_id "
    "FROM video_ai_chat_messages m JOIN videos v ON v.id = m.video_id "
    "WHERE COALESCE(m.user_id, :admin) IS NOT NULL "
    "ORDER BY uid, m.video_id, m.created_at, m.id"
)
_STREAMS = sa.text(
    "SELECT m.user_id AS uid, m.stream_id AS key, m.role, m.content, m.cost, "
    "m.model, m.created_at, s.title, s.source_url, s.youtube_id "
    "FROM stream_ai_chat_messages m JOIN stream_ai_state s ON s.id = m.stream_id "
    "ORDER BY uid, m.stream_id, m.created_at, m.id"
)


def _youtube_id(url: str | None) -> str | None:
    """The id in a YouTube watch / youtu.be URL (frozen copy, no app imports)."""
    if not url:
        return None
    try:
        p = urlparse(url.strip())
    except ValueError:
        return None
    host = p.netloc.lower()
    if host in ("youtu.be", "www.youtu.be"):
        vid = p.path.strip("/").split("/")[0]
    elif host.endswith("youtube.com"):
        if p.path == "/watch":
            vid = (parse_qs(p.query).get("v") or [""])[0]
        elif p.path.startswith(("/shorts/", "/live/", "/embed/")):
            vid = p.path.split("/")[2] if len(p.path.split("/")) > 2 else ""
        else:
            vid = ""
    else:
        return None
    return vid if len(vid) == 11 else None


def _title(raw: str | None) -> str:
    title = " ".join((raw or "").split()) or "Video"
    if len(title) > _TITLE_CHARS:
        title = title[: _TITLE_CHARS - 1].rstrip() + "…"
    return title


def _copy(bind: sa.Connection, rows: Sequence[Any], *, stream: bool) -> None:
    current: tuple[int, int] | None = None
    thread_id: int | None = None
    ref: dict[str, Any] = {}
    for row in rows:
        if (row.uid, row.key) != current:
            current = (row.uid, row.key)
            youtube_id = row.youtube_id if stream else _youtube_id(row.source_url)
            ref = {
                "library_id": None if stream else row.key,
                "youtube_id": youtube_id,
                "url": (
                    row.source_url or f"https://www.youtube.com/watch?v={youtube_id}"
                )
                if stream
                else None,
                "title": row.title or "",
            }
            bind.execute(
                sa.text(
                    "INSERT INTO ask_threads (user_id, title, scope, created_at, "
                    "updated_at) VALUES (:u, :t, :s, :c, :c)"
                ),
                {
                    "u": row.uid,
                    "t": _title(row.title),
                    "s": json.dumps({"video": ref, _MARK: _MARK_VALUE}),
                    "c": row.created_at,
                },
            )
            thread_id = bind.execute(sa.text("SELECT last_insert_rowid()")).scalar()
        sources = (
            json.dumps({"kind": "video", "video": ref}, ensure_ascii=False)
            if row.role == "assistant"
            else None
        )
        bind.execute(
            sa.text(
                "INSERT INTO ask_messages (thread_id, role, content, sources, cost, "
                "model, created_at) VALUES (:t, :r, :c, :s, :cost, :m, :at)"
            ),
            {
                "t": thread_id,
                "r": row.role,
                "c": row.content,
                "s": sources,
                "cost": row.cost,
                "m": row.model,
                "at": row.created_at,
            },
        )
        bind.execute(
            sa.text("UPDATE ask_threads SET updated_at = :at WHERE id = :t"),
            {"at": row.created_at, "t": thread_id},
        )


def upgrade() -> None:
    bind = op.get_bind()
    admin = bind.execute(
        sa.text(
            "SELECT id FROM users WHERE is_admin = 1 AND disabled = 0 "
            "ORDER BY id LIMIT 1"
        )
    ).scalar()
    _copy(bind, bind.execute(_LIBRARY, {"admin": admin}).fetchall(), stream=False)
    _copy(bind, bind.execute(_STREAMS).fetchall(), stream=True)


def downgrade() -> None:
    bind = op.get_bind()
    ids = [
        row.id
        for row in bind.execute(sa.text("SELECT id, scope FROM ask_threads"))
        if (json.loads(row.scope or "{}") or {}).get(_MARK) == _MARK_VALUE
    ]
    for thread_id in ids:
        bind.execute(
            sa.text("DELETE FROM ask_messages WHERE thread_id = :t"), {"t": thread_id}
        )
        bind.execute(sa.text("DELETE FROM ask_threads WHERE id = :t"), {"t": thread_id})
