"""Per-user watch state: resume position and last-watched time for each video.

History is the one thing users do not share. The library, playlists, tags and
notes are common; ``user_video_state`` holds each user's own place in each video.
The legacy ``videos.last_position_sec`` / ``videos.last_watched_at`` columns are
never read or written here: they were copied to the first administrator when
accounts were introduced (``services/auth/accounts.py``).
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Session, col, select

from ..database import rowcount
from ..models import UserVideoState, utcnow

# SQLite allows 32766 bound parameters; stay well under it for IN (...) lists.
_CHUNK = 500


def get_states(
    session: Session, user_id: int, video_ids: Iterable[int]
) -> dict[int, UserVideoState]:
    """The user's state rows for the given videos, keyed by video id."""
    ids = [vid for vid in video_ids if vid is not None]
    out: dict[int, UserVideoState] = {}
    for start in range(0, len(ids), _CHUNK):
        chunk = ids[start : start + _CHUNK]
        rows = session.exec(
            select(UserVideoState).where(
                UserVideoState.user_id == user_id,
                col(UserVideoState.video_id).in_(chunk),
            )
        )
        for row in rows:
            out[row.video_id] = row
    return out


def record_progress(
    session: Session, user_id: int, video_id: int, position_sec: float
) -> None:
    """Upsert the user's position and stamp it as watched now."""
    now = utcnow()
    statement = sqlite_insert(UserVideoState).values(
        user_id=user_id,
        video_id=video_id,
        position_sec=position_sec,
        last_watched_at=now,
    )
    session.execute(
        statement.on_conflict_do_update(
            index_elements=["user_id", "video_id"],
            set_={"position_sec": position_sec, "last_watched_at": now},
        )
    )
    session.commit()


def expire_stale(session: Session, cutoff) -> int:
    """Zero every user's saved position that was last touched before ``cutoff``."""
    result = session.execute(
        update(UserVideoState)
        .where(
            col(UserVideoState.last_watched_at).is_not(None),
            UserVideoState.last_watched_at < cutoff,
            col(UserVideoState.position_sec) > 0,
        )
        .values(position_sec=0.0)
    )
    session.commit()
    return rowcount(result)
