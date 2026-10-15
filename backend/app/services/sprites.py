"""Seek-preview sprite sheet generation and enqueue helpers."""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Literal

from sqlalchemy.orm.exc import StaleDataError
from sqlmodel import Session

from ..config import DOWNLOADS_DIR, SPRITE_CONCURRENCY, SPRITES_DIR
from ..database import engine
from ..models import Video
from . import activity
from .metadata import delete_sprite_files, generate_sprite_sheet, sprites_exist

logger = logging.getLogger(__name__)

SpriteStatus = Literal["ready", "generating"]


def _build_sprites(video_id: int, reason: str, cancel: threading.Event) -> None:
    """Generate the sprite sheet for one video (runs on a pool thread)."""
    with Session(engine) as session:
        video = session.get(Video, video_id)
        if video is None:
            return
        title = video.title
        path = (DOWNLOADS_DIR / video.file_path).resolve()
        if DOWNLOADS_DIR not in path.parents and path != DOWNLOADS_DIR:
            return
        if not path.is_file():
            return
        if sprites_exist(SPRITES_DIR, video_id):
            return

    with activity.track(
        "sprites",
        "Building seek previews",
        reason=reason,
        engine="ffmpeg",
        detail=title,
        video_id=video_id,
    ) as handle:
        duration: float | None = None
        with Session(engine) as session:
            video = session.get(Video, video_id)
            if video is None:
                handle.discard()
                return
            path = (DOWNLOADS_DIR / video.file_path).resolve()
            if DOWNLOADS_DIR not in path.parents and path != DOWNLOADS_DIR:
                handle.discard()
                return
            if not path.is_file():
                handle.discard()
                return
            if sprites_exist(SPRITES_DIR, video_id):
                handle.discard()
                return
            duration = video.duration_sec

        # ffmpeg can take minutes — do not hold a SQLite transaction open.
        sprite = generate_sprite_sheet(
            path,
            SPRITES_DIR,
            video_id,
            duration=duration,
            cancel_event=cancel,
        )
        if not sprite:
            return

        with Session(engine) as session:
            video = session.get(Video, video_id)
            if video is None:
                delete_sprite_files(SPRITES_DIR, video_id)
                handle.discard()
                return
            if video.sprite_path == sprite:
                return
            video.sprite_path = sprite
            session.add(video)
            try:
                session.commit()
            except StaleDataError:
                session.rollback()
                handle.discard()


class SpritePool:
    """One bounded pool of threads that build seek-preview sprite sheets.

    A bulk import enqueues thousands of videos. Each enqueue is only a queue entry;
    at most ``concurrency`` threads (``SPRITE_CONCURRENCY``) take them one at a time,
    so the thread count never depends on the size of the backlog. Threads start on
    the first enqueue and end on ``stop()``, which the worker registry calls at
    shutdown. Entries that never ran are dropped: the watch page asks again.

    The pool follows the ``ManagedWorker`` protocol, with one difference: its threads
    start on demand, so ``is_alive`` means "accepting work".
    """

    name = "sprites"
    stop_timeout = 5.0

    def __init__(self, concurrency: int = SPRITE_CONCURRENCY) -> None:
        self._concurrency = max(1, concurrency)
        self._cond = threading.Condition()
        self._queue: deque[tuple[int, str]] = deque()
        self._generating: set[int] = set()
        self._threads: list[threading.Thread] = []
        self._closed = False
        # Set by signal_stop: running ffmpeg is cancelled instead of awaited.
        self._cancel = threading.Event()

    def start(self) -> None:
        with self._cond:
            self._closed = False
            self._cancel.clear()

    @property
    def is_alive(self) -> bool:
        with self._cond:
            return not self._closed

    @property
    def healthy(self) -> bool:
        return self.is_alive

    def signal_stop(self) -> None:
        self._cancel.set()
        with self._cond:
            self._closed = True
            dropped = len(self._queue)
            for video_id, _ in self._queue:
                self._generating.discard(video_id)
            self._queue.clear()
            self._cond.notify_all()
            if dropped:
                activity.note_queued("sprites", -dropped)

    def stop(self, timeout: float | None = None) -> bool:
        """Refuse new work, drop the backlog and wait for running builds to end."""
        self.signal_stop()
        deadline = time.monotonic() + (5.0 if timeout is None else timeout)
        with self._cond:
            threads = list(self._threads)
        for thread in threads:
            thread.join(max(0.0, deadline - time.monotonic()))
        with self._cond:
            self._threads = [t for t in self._threads if t.is_alive()]
            return not self._threads

    def enqueue(self, video_id: int, reason: str) -> bool:
        """Queue a build. False when one is already queued or running (or closed)."""
        with self._cond:
            if self._closed or video_id in self._generating:
                return False
            self._generating.add(video_id)
            self._queue.append((video_id, reason))
            self._threads = [t for t in self._threads if t.is_alive()]
            if len(self._threads) < self._concurrency:
                thread = threading.Thread(
                    target=self._loop,
                    name=f"sprites-{len(self._threads) + 1}",
                    daemon=True,
                )
                self._threads.append(thread)
                thread.start()
            self._cond.notify()
            activity.note_queued("sprites", 1)
            return True

    def in_progress(self, video_id: int) -> bool:
        with self._cond:
            return video_id in self._generating

    def wait_idle(self, timeout: float) -> bool:
        """Block until nothing is queued or running. False on timeout."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._generating:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)
        return True

    def _loop(self) -> None:
        while True:
            with self._cond:
                while not self._queue and not self._closed:
                    self._cond.wait()
                if self._closed:
                    return
                video_id, reason = self._queue.popleft()
                activity.note_queued("sprites", -1)
            try:
                _build_sprites(video_id, reason, self._cancel)
            except Exception:
                logger.exception("Sprite generation failed for video %s", video_id)
            finally:
                with self._cond:
                    self._generating.discard(video_id)
                    self._cond.notify_all()


#: The process-wide pool (tests wait on it and reopen it between tests).
sprite_pool = SpritePool()


def enqueue_sprite_generation(
    video_id: int,
    *,
    reason: str = "Seek preview sprites needed",
) -> SpriteStatus:
    """Ensure sprites exist; queue a build on the pool if needed. Idempotent."""
    if sprites_exist(SPRITES_DIR, video_id):
        return "ready"
    sprite_pool.enqueue(video_id, reason)
    return "generating"


def sprites_in_progress(video_id: int) -> bool:
    """True while a sprite sheet is queued or being built for this video."""
    return sprite_pool.in_progress(video_id)
