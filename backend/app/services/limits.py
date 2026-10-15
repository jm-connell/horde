"""Concurrency caps for endpoints that start expensive work on request.

Each endpoint runs in the server's shared worker-thread pool. Without a cap, a
handful of slow requests (a link yt-dlp takes a minute to read, a burst of
thumbnail grabs) occupy every thread and freeze the whole API. The limits here
fail fast with 429 instead of queueing without bound.

Instances live on ``app.state`` (created by ``app.security.install_security``) so
every app, including each test app, gets its own.
"""

from __future__ import annotations

import concurrent.futures
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, TypeVar

from fastapi import HTTPException, Request

T = TypeVar("T")

EXTRACT_MAX_CONCURRENT = 3
EXTRACT_QUEUE_WAIT_SEC = 15.0
EXTRACT_TIMEOUT_SEC = 60.0
THUMB_GRAB_MAX_CONCURRENT = 2
THUMB_GRAB_QUEUE_WAIT_SEC = 30.0


class ConcurrencyLimit:
    """At most ``max_concurrent`` callers inside ``slot()``; the rest wait, then 429."""

    def __init__(self, label: str, max_concurrent: int, wait_sec: float) -> None:
        self.label = label
        self.wait_sec = wait_sec
        self._slots = threading.BoundedSemaphore(max_concurrent)

    def _acquire(self) -> None:
        if not self._slots.acquire(timeout=self.wait_sec):
            raise HTTPException(
                status_code=429,
                detail=f"Too many {self.label} in progress. Try again shortly.",
                headers={"Retry-After": "5"},
            )

    def _release(self) -> None:
        self._slots.release()

    @contextmanager
    def slot(self) -> Iterator[None]:
        self._acquire()
        try:
            yield
        finally:
            self._release()


class ExtractionGate(ConcurrencyLimit):
    """Bounds yt-dlp link reads and gives each a wall-clock timeout.

    The work runs on the gate's own small pool. When the timeout passes the request
    returns 504, but the slot stays taken until the work really ends, so abandoned
    reads can never pile up past ``max_concurrent``.
    """

    def __init__(self, max_concurrent: int, wait_sec: float, timeout_sec: float):
        super().__init__("link checks", max_concurrent, wait_sec)
        self.timeout_sec = timeout_sec
        self._pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=max_concurrent, thread_name_prefix="extract-gate"
        )

    def run(self, fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        self._acquire()
        try:
            future = self._pool.submit(fn, *args, **kwargs)
        except BaseException:
            self._release()
            raise
        future.add_done_callback(lambda _f: self._release())
        try:
            return future.result(timeout=self.timeout_sec)
        except concurrent.futures.TimeoutError as exc:
            raise HTTPException(
                status_code=504, detail="Timed out reading that link"
            ) from exc


def new_extraction_gate() -> ExtractionGate:
    return ExtractionGate(
        EXTRACT_MAX_CONCURRENT, EXTRACT_QUEUE_WAIT_SEC, EXTRACT_TIMEOUT_SEC
    )


def new_thumbnail_grab_limit() -> ConcurrencyLimit:
    return ConcurrencyLimit(
        "thumbnail grabs", THUMB_GRAB_MAX_CONCURRENT, THUMB_GRAB_QUEUE_WAIT_SEC
    )


def extraction_gate(request: Request) -> ExtractionGate:
    """FastAPI dependency: the app's yt-dlp read gate."""
    return request.app.state.extraction_gate


def thumbnail_grab_limit(request: Request) -> ConcurrencyLimit:
    """FastAPI dependency: the app's cap on concurrent ffmpeg frame grabs."""
    return request.app.state.thumbnail_grab_limit
