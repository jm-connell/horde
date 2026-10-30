"""The user's own data for Ask about Horde, when they allow it.

Only what a question is about is sent, as short lines: words in the question
(and the previous one, for follow-ups) and the page the user is on pick the
topics, and each topic has a fixed size. A question that names no topic but
is about the user ("my", "I") gets a small overview instead. Everything is
read as the asking user sees it: their own history, playlists they can open
and download jobs they may see.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from datetime import timedelta

from sqlmodel import Session, col, func, select

from ...models import (
    DownloadJob,
    JobStatus,
    Playlist,
    PlaylistItem,
    UserVideoState,
    Video,
    utcnow,
)
from .. import playlists, user_state
from ..auth.accounts import AuthUser
from ..downloads import device_access

logger = logging.getLogger(__name__)


def _words(text: str) -> frozenset[str]:
    """A word set written as one string, for the long lists below."""
    return frozenset(text.split())


_TOPIC_WORDS: dict[str, frozenset[str]] = {
    "downloads": _words(
        "download downloads downloaded downloading queue queued failed fail "
        "failing failure error errors stuck job jobs retry"
    ),
    "history": _words(
        "watched watching history recently yesterday seen finished unfinished"
    ),
    "playlists": _words("playlist playlists"),
    "library": _words(
        "library channels channel storage space size biggest largest many "
        "count stats statistics total"
    ),
    "search": _words("find search looking called named titled remember"),
    "suggest": _words(
        "suggest suggestion recommend recommendation should next bored tonight pick"
    ),
}
#: A question about the user's own things ("I" alone is in every how-to).
_PERSONAL = _words("my mine")
#: Words that say what to look for rather than what it is about.
_NOT_SEARCH_TERMS = _words(
    "a an the and or of to in on at for from with about that this these those "
    "it its is was are were be been do does did can could would should i me my "
    "mine you your find search looking look show tell give list which what "
    "where when who how video videos clip clips watched watch watching saw seen "
    "remember called named titled one ones thing something last ago month months "
    "week weeks year years day days yesterday today recently recent there some "
    "any all library download downloaded please"
)
_WORD = re.compile(r"[a-z0-9']+")
_PAGE_TOPICS = (("/download", "downloads"), ("/history", "history"))

_MAX_JOBS = 6
_MAX_HISTORY = 12
_MAX_RESULTS = 8
_MAX_PLAYLISTS = 15
_ERROR_CHARS = 220
_TITLE_CHARS = 90


def topics(question: str, previous: str = "", page: str = "") -> set[str]:
    """Which kinds of data the question needs (empty: none)."""
    words = set(_WORD.findall(question.lower()))
    earlier = set(_WORD.findall(previous.lower()))
    found = {
        name
        for name, vocab in _TOPIC_WORDS.items()
        if words & vocab or (earlier & vocab and words & _PERSONAL)
    }
    if {"did", "watch"} <= words:
        found.add("history")
    for prefix, name in _PAGE_TOPICS:
        if f"({prefix}" in page and words & _PERSONAL:
            found.add(name)
    if not found and words & _PERSONAL:
        found.add("overview")
    return found


def search_terms(question: str) -> str:
    """The words worth searching the library for (empty when none are left)."""
    words = [w for w in _WORD.findall(question.lower()) if w not in _NOT_SEARCH_TERMS]
    return " ".join(words[:8])


def _clip(text: str | None, limit: int = _TITLE_CHARS) -> str:
    value = " ".join((text or "").split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _duration(seconds: float | None) -> str:
    if not seconds:
        return ""
    total = int(seconds)
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02}:{secs:02}" if hours else f"{minutes}:{secs:02}"


def _video_line(video: Video, state: UserVideoState | None) -> str:
    parts = [f'#{video.id} "{_clip(video.title)}"']
    if video.channel:
        parts.append(f"by {_clip(video.channel, 40)}")
    if length := _duration(video.duration_sec):
        parts.append(length)
    if video.published_at:
        parts.append(f"uploaded {video.published_at.date().isoformat()}")
    if state is not None and state.last_watched_at is not None:
        status = "finished" if state.finished_at else "partly watched"
        parts.append(f"{status} {state.last_watched_at.date().isoformat()}")
    else:
        parts.append("not watched")
    return "- " + ", ".join(parts)


def _videos_block(
    session: Session, user: AuthUser, title: str, videos: Iterable[Video]
) -> str | None:
    rows = [v for v in videos if v.id is not None]
    if not rows:
        return None
    states = user_state.get_states(session, user.id, [v.id for v in rows if v.id])
    lines = [_video_line(v, states.get(v.id or 0)) for v in rows]
    return f"{title}:\n" + "\n".join(lines)


def _downloads(session: Session, user: AuthUser) -> str | None:
    from ..downloads.queue import download_queue

    active = list(
        session.exec(
            select(DownloadJob)
            .where(
                col(DownloadJob.status).in_([JobStatus.queued, JobStatus.downloading])
            )
            .order_by(col(DownloadJob.created_at).asc())
            .limit(_MAX_JOBS * 2)
        ).all()
    )
    since = utcnow() - timedelta(days=14)
    failed = list(
        session.exec(
            select(DownloadJob)
            .where(
                DownloadJob.status == JobStatus.error,
                col(DownloadJob.created_at) >= since,
            )
            .order_by(col(DownloadJob.created_at).desc())
            .limit(_MAX_JOBS * 2)
        ).all()
    )
    done = list(
        session.exec(
            select(DownloadJob)
            .where(DownloadJob.status == JobStatus.completed)
            .order_by(col(DownloadJob.created_at).desc())
            .limit(_MAX_JOBS)
        ).all()
    )
    hidden = device_access.hidden_job_ids(session, user, [*active, *failed, *done])

    def name(job: DownloadJob) -> str:
        return f'"{_clip(job.title_override or job.title)}"' if job.title else job.url

    hold = download_queue.space_hold()
    lines = [
        "Download queue: "
        + ("paused by the administrator" if download_queue.is_paused() else "running")
        + (f"; waiting: {hold.reason}" if hold else "")
    ]
    for job in [j for j in active if j.id not in hidden][:_MAX_JOBS]:
        state = "downloading" if job.status == JobStatus.downloading else "queued"
        progress = f" {round(job.progress)}%" if job.progress else ""
        lines.append(f"- {state}{progress}: {name(job)} ({job.quality_preset})")
    for job in [j for j in failed if j.id not in hidden][:_MAX_JOBS]:
        when = job.created_at.date().isoformat()
        kind = f" [{job.error_kind}]" if job.error_kind else ""
        lines.append(
            f"- FAILED {when}: {name(job)}{kind}: {_clip(job.error, _ERROR_CHARS)}"
        )
    for job in [j for j in done if j.id not in hidden][:_MAX_JOBS]:
        video = f" (video #{job.video_id})" if job.video_id else ""
        lines.append(f"- done {job.created_at.date().isoformat()}: {name(job)}{video}")
    return "Downloads:\n" + "\n".join(lines)


def _history(session: Session, user: AuthUser) -> str | None:
    rows = session.exec(
        select(UserVideoState, Video)
        .join(Video, col(Video.id) == UserVideoState.video_id)
        .where(
            UserVideoState.user_id == user.id,
            col(UserVideoState.last_watched_at).is_not(None),
        )
        .order_by(col(UserVideoState.last_watched_at).desc())
        .limit(_MAX_HISTORY)
    ).all()
    if not rows:
        return "Watch history: nothing watched yet."
    lines = [_video_line(video, state) for state, video in rows]
    return "Recently watched (newest first):\n" + "\n".join(lines)


def _playlists(session: Session, user: AuthUser) -> str | None:
    counts = (
        select(PlaylistItem.playlist_id, func.count().label("n"))
        .group_by(col(PlaylistItem.playlist_id))
        .subquery()
    )
    rows = session.exec(
        select(Playlist, counts.c.n)
        .outerjoin(counts, counts.c.playlist_id == Playlist.id)
        .where(playlists.visible_to(user))
        .order_by(col(Playlist.position).asc(), col(Playlist.id).asc())
        .limit(_MAX_PLAYLISTS)
    ).all()
    if not rows:
        return "Playlists: none yet."
    lines = []
    for playlist, count in rows:
        mine = "yours" if playlist.owner_user_id == user.id else "shared"
        lines.append(
            f'- playlist #{playlist.id} "{_clip(playlist.name, 60)}", '
            f"{count or 0} videos, {mine}, {playlist.visibility.value}"
        )
    return "Playlists you can open:\n" + "\n".join(lines)


def _library(session: Session) -> str | None:
    ready = col(Video.needs_review).is_(False)
    total, size, channels = session.exec(
        select(
            func.count(col(Video.id)),
            func.coalesce(func.sum(Video.file_size), 0),
            func.count(func.distinct(Video.channel)),
        ).where(ready)
    ).one()
    top = session.exec(
        select(Video.channel, func.count().label("n"))
        .where(ready, col(Video.channel).is_not(None))
        .group_by(col(Video.channel))
        .order_by(func.count().desc())
        .limit(8)
    ).all()
    gib = (size or 0) / 1024**3
    lines = [f"Library: {total} videos, {channels} channels, {gib:.1f} GiB"]
    if top:
        lines.append(
            "Biggest channels: " + ", ".join(f"{_clip(c, 40)} ({n})" for c, n in top)
        )
    return "\n".join(lines)


def _search(session: Session, user: AuthUser, question: str) -> str | None:
    from .search import hybrid_search

    terms = search_terms(question)
    if not terms:
        return None
    try:
        videos, _ = hybrid_search(session, terms, user_id=user.id)
    except Exception:
        logger.warning("help chat library search failed", exc_info=True)
        return None
    block = _videos_block(
        session, user, f'Library videos matching "{terms}"', videos[:_MAX_RESULTS]
    )
    return block or f'Library search for "{terms}": no matches.'


def _suggest(session: Session, user: AuthUser) -> str | None:
    recent = session.exec(
        select(Video)
        .where(col(Video.needs_review).is_(False))
        .order_by(col(Video.added_at).desc())
        .limit(60)
    ).all()
    states = user_state.get_states(session, user.id, [v.id for v in recent if v.id])
    unwatched = [v for v in recent if v.id not in states][:_MAX_RESULTS]
    resume = session.exec(
        select(Video)
        .join(UserVideoState, col(UserVideoState.video_id) == Video.id)
        .where(
            UserVideoState.user_id == user.id,
            col(UserVideoState.finished_at).is_(None),
            col(UserVideoState.position_sec) > 0,
        )
        .order_by(col(UserVideoState.last_watched_at).desc())
        .limit(3)
    ).all()
    blocks = [
        _videos_block(session, user, "Recently added, not watched yet", unwatched),
        _videos_block(session, user, "Started but not finished", resume),
    ]
    return "\n\n".join(b for b in blocks if b) or None


def gather(
    session: Session,
    user: AuthUser,
    question: str,
    *,
    previous: str = "",
    page: str = "",
) -> str:
    """The data blocks this question needs, or "" when it needs none."""
    wanted = topics(question, previous, page)
    blocks: list[str | None] = []
    if "overview" in wanted:
        blocks += [_library(session), _history(session, user)]
    if "downloads" in wanted:
        blocks.append(_downloads(session, user))
    if "search" in wanted:
        blocks.append(_search(session, user, question))
    if "history" in wanted:
        blocks.append(_history(session, user))
    if "suggest" in wanted:
        blocks.append(_suggest(session, user))
    if "playlists" in wanted:
        blocks.append(_playlists(session, user))
    if "library" in wanted:
        blocks.append(_library(session))
    seen: list[str] = []
    for block in blocks:
        if block and block not in seen:
            seen.append(block)
    return "\n\n".join(seen)
