"""Retry English captions after timedtext 429s instead of treating a miss as final.

Download finalize and metadata sync call ``apply_subtitle_outcome``. A small
worker wakes often, waits out a global timedtext cooldown, then fetches one
due pending video (newest downloads first).
"""

from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR
from ..database import engine
from ..models import Video, as_utc
from . import activity, library
from .ytdlp_common import (
    ERROR_KIND_BOT,
    ERROR_KIND_COOKIES,
    ERROR_KIND_MEMBERS,
    ERROR_KIND_POT,
    ERROR_KIND_RATE_LIMIT,
    ERROR_KIND_UNAVAILABLE,
    ERROR_KIND_UNKNOWN,
    classify_ytdlp_error,
)

logger = logging.getLogger(__name__)

# After a 429, wait before the next timedtext hit (per video and globally).
BACKOFF_SECONDS = (300, 600, 1200, 2400, 3600)  # 5m … 1h cap
POLL_INTERVAL_SEC = 15
STARTUP_DELAY_SEC = 20
INTER_FETCH_SEC = 15
# Startup recovery of forgotten empty captions (never metadata-synced).
_RECOVER_MAX_AGE = timedelta(days=2)

_NO_SUBTITLES_MESSAGE = re.compile(
    r"(?i)("
    r"there'?s no subtitles"
    r"|there is no subtitles"
    r"|no subtitles for the requested"
    r"|video doesn'?t have (any )?subtitles"
    r"|did not get any subtitles"
    r"|subtitles are not available"
    r"|has no subtitles"
    r")"
)
_HTTP_404 = re.compile(r"(?i)http error 404")
_RETRYABLE_KINDS = frozenset(
    {
        ERROR_KIND_RATE_LIMIT,
        ERROR_KIND_BOT,
        ERROR_KIND_POT,
        ERROR_KIND_UNKNOWN,
    }
)

_stop = threading.Event()
_thread: Optional[threading.Thread] = None
_cooldown_lock = threading.Lock()
_global_retry_after: Optional[datetime] = None


@dataclass
class SubtitleFetchOutcome:
    tracks: list[dict[str, Any]] = field(default_factory=list)
    retryable: bool = False
    kind: Optional[str] = None
    message: Optional[str] = None


def reset_for_tests() -> None:
    """Clear process-wide timedtext cooldown (unit tests only)."""
    global _global_retry_after
    with _cooldown_lock:
        _global_retry_after = None


def backoff_seconds(attempts: int) -> int:
    """Delay after ``attempts`` retryable failures (1-based)."""
    if attempts < 1:
        attempts = 1
    idx = min(attempts, len(BACKOFF_SECONDS)) - 1
    return BACKOFF_SECONDS[idx]


def note_global_cooldown(delay_sec: float) -> None:
    """Block further timedtext fetches until ``delay_sec`` from now (max wins)."""
    global _global_retry_after
    if delay_sec <= 0:
        return
    until = datetime.now(timezone.utc) + timedelta(seconds=delay_sec)
    with _cooldown_lock:
        if _global_retry_after is None or until > _global_retry_after:
            _global_retry_after = until


def seconds_until_global_cooldown() -> float:
    with _cooldown_lock:
        if _global_retry_after is None:
            return 0.0
        delta = (_global_retry_after - datetime.now(timezone.utc)).total_seconds()
        return max(0.0, delta)


def subtitle_failure_retryable(text: str) -> bool:
    """True when a yt-dlp subtitle error should be retried later."""
    raw = (text or "").strip()
    if not raw:
        return False
    if _NO_SUBTITLES_MESSAGE.search(raw) or _HTTP_404.search(raw):
        return False
    kind, _ = classify_ytdlp_error(raw)
    if kind in (ERROR_KIND_COOKIES, ERROR_KIND_MEMBERS, ERROR_KIND_UNAVAILABLE):
        return False
    if kind in _RETRYABLE_KINDS:
        return True
    # "Unable to download video subtitles" without 404 — often transient HTTP.
    return True


def outcome_from_fetch(
    tracks: list[dict[str, Any]],
    *,
    messages: Optional[list[str]] = None,
    exc: Optional[BaseException] = None,
) -> SubtitleFetchOutcome:
    """Map on-disk tracks + yt-dlp logs into a fetch outcome."""
    if tracks:
        return SubtitleFetchOutcome(tracks=list(tracks), retryable=False)
    parts = [str(m).strip() for m in (messages or []) if m and str(m).strip()]
    if exc is not None:
        text = str(exc).strip()
        if text:
            parts.append(text)
    blob = "\n".join(parts).strip()
    if not blob:
        return SubtitleFetchOutcome(tracks=[], retryable=False)
    retryable = subtitle_failure_retryable(blob)
    kind, message = classify_ytdlp_error(blob)
    return SubtitleFetchOutcome(
        tracks=[],
        retryable=retryable,
        kind=kind,
        message=message,
    )


def captions_fetch_allowed(video: Video) -> bool:
    """False while this video (or the global timedtext gate) is in backoff."""
    if not video.source_url:
        return False
    if seconds_until_global_cooldown() > 0:
        return False
    retry = as_utc(video.subtitles_retry_after)
    if retry is not None and retry > datetime.now(timezone.utc):
        return False
    return True


def apply_subtitle_outcome(video_id: int, outcome: SubtitleFetchOutcome) -> None:
    """Persist tracks or keep ``subtitles_pending`` with a retry timestamp."""
    got_tracks = False
    with Session(engine) as session:
        video = session.get(Video, video_id)
        if video is None:
            return
        existing = library.parse_subtitles(video.subtitles)
        if outcome.tracks:
            video.subtitles = library.dump_subtitles(outcome.tracks)
            video.subtitles_pending = False
            video.subtitles_retry_after = None
            video.subtitles_fetch_attempts = 0
            got_tracks = True
        elif outcome.retryable:
            if existing:
                # Refresh 429d but we already have VTT — don't strand the UI.
                video.subtitles_pending = False
                video.subtitles_retry_after = None
            else:
                attempts = int(video.subtitles_fetch_attempts or 0) + 1
                delay = backoff_seconds(attempts)
                video.subtitles_pending = True
                video.subtitles_fetch_attempts = attempts
                video.subtitles_retry_after = datetime.now(timezone.utc) + timedelta(
                    seconds=delay
                )
                note_global_cooldown(delay)
                logger.info(
                    "Subtitles delayed for video %s (%s); retry in %ss",
                    video_id,
                    outcome.kind or "error",
                    delay,
                )
        else:
            if not existing:
                video.subtitles_pending = False
                video.subtitles_retry_after = None
                video.subtitles_fetch_attempts = 0
        session.add(video)
        session.commit()
    if got_tracks:
        try:
            from .ai import enqueue_for_video

            enqueue_for_video(video_id, include_tags=False, force=False)
        except Exception:  # noqa: BLE001
            logger.debug("subtitle re-embed enqueue failed", exc_info=True)


def recover_unsynced_missing_captions() -> int:
    """Re-open forgotten empty-caption downloads (never metadata-synced)."""
    count = 0
    with Session(engine) as session:
        rows = session.exec(
            select(Video).where(
                Video.source_url.is_not(None),  # type: ignore[attr-defined]
                Video.subtitles_pending == False,  # noqa: E712
            )
        ).all()
        now = datetime.now(timezone.utc)
        cutoff = now - _RECOVER_MAX_AGE
        for video in rows:
            if video.metadata_synced_at is not None:
                continue
            added = as_utc(video.added_at)
            if added is not None and added < cutoff:
                continue
            if library.parse_subtitles(video.subtitles):
                continue
            video.subtitles_pending = True
            video.subtitles_retry_after = now
            video.subtitles_fetch_attempts = int(video.subtitles_fetch_attempts or 0)
            session.add(video)
            count += 1
        if count:
            session.commit()
    if count:
        logger.info("Queued %s video(s) with missing captions for retry", count)
    return count


def next_due_video(session: Session) -> Optional[Video]:
    """Newest library download whose caption retry is due."""
    now = datetime.now(timezone.utc)
    rows = session.exec(
        select(Video).where(
            Video.subtitles_pending == True,  # noqa: E712
            Video.source_url.is_not(None),  # type: ignore[attr-defined]
        )
    ).all()
    due: list[Video] = []
    for video in rows:
        retry = as_utc(video.subtitles_retry_after)
        if retry is not None and retry > now:
            continue
        due.append(video)

    def _added(video: Video) -> datetime:
        stamp = as_utc(video.added_at)
        if stamp is not None:
            return stamp
        return datetime.min.replace(tzinfo=timezone.utc)

    due.sort(key=_added, reverse=True)
    return due[0] if due else None


def process_due_subtitle() -> bool:
    """Fetch captions for one due video. Returns True if a timedtext call ran."""
    if seconds_until_global_cooldown() > 0:
        return False
    video_id: Optional[int] = None
    title: Optional[str] = None
    source_url: Optional[str] = None
    media = None
    with Session(engine) as session:
        video = next_due_video(session)
        if video is None or video.id is None:
            return False
        video_id = video.id
        title = video.title
        source_url = video.source_url
        media = DOWNLOADS_DIR / video.file_path
    if not source_url or media is None or not media.is_file():
        if video_id is not None:
            apply_subtitle_outcome(
                video_id,
                SubtitleFetchOutcome(tracks=[], retryable=False),
            )
        return False

    from .downloader import download_subtitles

    with activity.track(
        "subtitles",
        "Retrying subtitles",
        reason="Captions missed after download (rate limit or error)",
        engine="yt-dlp",
        detail=title,
        video_id=video_id,
    ):
        outcome = download_subtitles(media, source_url)
        apply_subtitle_outcome(video_id, outcome)
        note_global_cooldown(INTER_FETCH_SEC)
    return True


def _worker_loop() -> None:
    try:
        recover_unsynced_missing_captions()
    except Exception:  # noqa: BLE001
        logger.debug("subtitle pending recovery failed", exc_info=True)
    if _stop.wait(timeout=STARTUP_DELAY_SEC):
        return
    while not _stop.is_set():
        wait = seconds_until_global_cooldown()
        if wait > 0:
            if _stop.wait(timeout=min(wait, POLL_INTERVAL_SEC)):
                return
            continue
        ran = False
        try:
            ran = process_due_subtitle()
        except Exception:  # noqa: BLE001
            logger.debug("subtitle retry failed", exc_info=True)
            note_global_cooldown(INTER_FETCH_SEC)
        if ran:
            if _stop.wait(timeout=INTER_FETCH_SEC):
                return
            continue
        if _stop.wait(timeout=POLL_INTERVAL_SEC):
            return


def start_subtitle_retry_worker() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(
        target=_worker_loop, daemon=True, name="subtitle-retry"
    )
    _thread.start()


def stop_subtitle_retry_worker() -> None:
    _stop.set()
    thread = _thread
    if thread is not None and thread.is_alive():
        thread.join(timeout=5)
