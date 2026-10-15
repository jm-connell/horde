"""Concurrency caps for endpoints that start expensive work on request.

Each plain ``def`` endpoint runs in the server's shared worker-thread pool (40
threads). Without a cap, a handful of slow requests (a link yt-dlp takes a minute to
read, a burst of thumbnail grabs) occupy every thread and freeze the whole API. The
limits here fail fast with 429 instead of queueing without bound.

Three layers cooperate for yt-dlp-bound requests, outermost first:

1. ``YtdlpSlots`` (``ytdlp_slot`` dependency): at most ``YTDLP_REQUEST_THREADS``
   requests are inside yt-dlp work at once. The rest wait *as suspended coroutines*,
   not as threads, for up to ``YTDLP_SLOT_WAIT_SEC`` and then get 429. So yt-dlp
   traffic can never take more than that many of the shared pool's 40 threads.
2. ``ExtractionGate``: of those, ``EXTRACT_MAX_CONCURRENT`` run extractions on the
   gate's own pool, each with a wall-clock timeout (504). Others wait up to
   ``EXTRACT_QUEUE_WAIT_SEC`` (429).
3. The process-wide extract gate in ``ytdlp_common`` serialises the actual yt-dlp
   calls (with spacing) and gives up after ``HORDE_EXTRACT_QUEUE_TIMEOUT_SEC``.

Instances live on ``app.state`` (created by ``app.security.install_security``) so
every app, including each test app, gets its own.
"""

from __future__ import annotations

import concurrent.futures
import threading
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from typing import Any, TypeVar

import anyio
from fastapi import HTTPException, Request

from ..config import YTDLP_REQUEST_THREADS

T = TypeVar("T")

EXTRACT_MAX_CONCURRENT = 3
EXTRACT_QUEUE_WAIT_SEC = 15.0
EXTRACT_TIMEOUT_SEC = 60.0
YTDLP_SLOT_WAIT_SEC = 15.0
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


class YtdlpSlots:
    """Bounds how many requests may be inside yt-dlp work at once.

    A ``CapacityLimiter`` rather than a semaphore, because requests wait for a slot in
    the event loop and so cost no thread while they wait.
    """

    def __init__(self, max_requests: int, wait_sec: float) -> None:
        self.wait_sec = wait_sec
        self.limiter = anyio.CapacityLimiter(max_requests)

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        # A fresh borrower per use: the dependency's exit may run in another task.
        borrower = object()
        try:
            with anyio.fail_after(self.wait_sec):
                await self.limiter.acquire_on_behalf_of(borrower)
        except TimeoutError as exc:
            raise HTTPException(
                status_code=429,
                detail="Too many link checks in progress. Try again shortly.",
                headers={"Retry-After": "5"},
            ) from exc
        try:
            yield
        finally:
            self.limiter.release_on_behalf_of(borrower)


def new_ytdlp_slots() -> YtdlpSlots:
    return YtdlpSlots(YTDLP_REQUEST_THREADS, YTDLP_SLOT_WAIT_SEC)


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


def ytdlp_slots(request: Request) -> YtdlpSlots:
    """The app's cap on request threads inside yt-dlp work."""
    return request.app.state.ytdlp_slots


async def ytdlp_slot(request: Request) -> AsyncIterator[None]:
    """FastAPI dependency: hold a yt-dlp slot while a ``def`` route runs.

    Declare it on the route (``dependencies=[Depends(ytdlp_slot)]``) so waiting
    requests queue in the event loop instead of occupying worker threads.
    """
    async with request.app.state.ytdlp_slots.slot():
        yield
