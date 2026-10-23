"""The notifier: a bounded queue and the worker thread that delivers from it.

Anything that wants to tell the administrator something calls
``ctx.notifier.emit(event, payload)`` (or ``notifications.emit``). ``emit`` only
looks up who is subscribed and appends to a queue: it never blocks and never
raises, so a slow ntfy server cannot slow a download down. The worker pops the
queue, folds bursts together and does the HTTP, with a few attempts per message.

Folding: for an event marked ``coalesce`` the first message of a quiet period goes
out at once; further ones for the same target wait and leave together as one
summary ("30 new videos downloaded") once a minute has passed since the last send.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..workers import BackgroundWorker
from . import events, targets, watchers
from .delivery import DeliveryError, Sender, send
from .render import render

logger = logging.getLogger(__name__)

#: Messages waiting for the worker; the oldest is dropped beyond this.
MAX_QUEUE = 500
#: A folded burst keeps at most this many payloads (the count stays exact).
MAX_PENDING = 200
COALESCE_WINDOW_SEC = 60.0
#: Pauses before the 2nd and 3rd attempt at one message.
RETRY_BACKOFF_SEC = (2.0, 8.0)
#: How often the worker looks at things nobody emits for (updates).
WATCH_INTERVAL_SEC = 300.0
#: Never wait longer than this between loops, whatever is (not) due.
IDLE_WAIT_SEC = 30.0


@dataclass
class _Item:
    target_id: str
    event: str
    payload: dict[str, Any]


@dataclass
class _Bucket:
    """What is waiting to be folded for one (target, event)."""

    last_sent: float | None = None
    pending: list[dict[str, Any]] = field(default_factory=list)


class Notifier:
    """Held on the ``AppContext`` (``ctx.notifier``)."""

    def __init__(
        self,
        *,
        sender: Sender = send,
        clock: Callable[[], float] = time.monotonic,
        window: float = COALESCE_WINDOW_SEC,
        backoff: tuple[float, ...] = RETRY_BACKOFF_SEC,
        max_queue: int = MAX_QUEUE,
    ) -> None:
        self._sender = sender
        self._clock = clock
        self._window = window
        self._backoff = backoff
        self._max_queue = max_queue
        self._lock = threading.Lock()
        self._queue: deque[_Item] = deque()
        self._buckets: dict[tuple[str, str], _Bucket] = {}
        self._seen: dict[str, float] = {}
        self._dropped = 0
        self._worker: BackgroundWorker | None = None
        self._next_watch = 0.0
        #: Things the worker looks at on its own (nobody emits them); see ``watchers.py``.
        self.watchers: list[Callable[[Notifier], None]] = [watchers.check_updates]

    # -- emitting --------------------------------------------------------------

    def emit(
        self,
        event: str,
        payload: dict[str, Any],
        *,
        dedupe_key: str | None = None,
        dedupe_ttl: float = 600.0,
    ) -> None:
        """Queue ``event`` for every subscribed target. Never blocks, never raises.

        ``dedupe_key`` drops a repeat of the same thing within ``dedupe_ttl`` seconds
        (a job reported twice, a broadcast that flaps).
        """
        try:
            if events.get(event) is None:
                logger.warning("ignoring unknown notification event %r", event)
                return
            ids = targets.subscribers(event, payload)
            if not ids or self._is_repeat(dedupe_key, dedupe_ttl):
                return
            with self._lock:
                for target_id in ids:
                    self._queue.append(_Item(target_id, event, payload))
                while len(self._queue) > self._max_queue:
                    self._queue.popleft()
                    self._dropped += 1
                    if self._dropped == 1 or self._dropped % 100 == 0:
                        logger.warning(
                            "notification queue full; dropped %d so far", self._dropped
                        )
            worker = self._worker
            if worker is not None:
                worker.wake()
        except Exception:
            logger.warning("could not queue a %s notification", event, exc_info=True)

    def _is_repeat(self, key: str | None, ttl: float) -> bool:
        if key is None:
            return False
        now = self._clock()
        with self._lock:
            self._seen = {k: t for k, t in self._seen.items() if t > now}
            if key in self._seen:
                return True
            self._seen[key] = now + ttl
            return False

    # -- delivering ------------------------------------------------------------

    def pump(self) -> float:
        """Deliver what is queued and what is due; returns seconds until more is due."""
        while True:
            with self._lock:
                item = self._queue.popleft() if self._queue else None
            if item is None:
                break
            self._accept(item)
        return self._flush_due()

    def _accept(self, item: _Item) -> None:
        spec = events.get(item.event)
        if spec is None or targets.get_target(item.target_id) is None:
            return
        if not spec.coalesce:
            self._deliver(item.target_id, item.event, [item.payload])
            return
        now = self._clock()
        bucket = self._buckets.setdefault((item.target_id, item.event), _Bucket())
        quiet = bucket.last_sent is None or now - bucket.last_sent >= self._window
        if quiet and not bucket.pending:
            bucket.last_sent = now
            self._deliver(item.target_id, item.event, [item.payload])
        elif len(bucket.pending) < MAX_PENDING:
            bucket.pending.append(item.payload)

    def _flush_due(self) -> float:
        now = self._clock()
        wait = IDLE_WAIT_SEC
        for (target_id, event), bucket in list(self._buckets.items()):
            if not bucket.pending:
                continue
            due_in = (bucket.last_sent or now) + self._window - now
            if due_in > 0:
                wait = min(wait, due_in)
                continue
            payloads, bucket.pending = bucket.pending, []
            bucket.last_sent = now
            self._deliver(target_id, event, payloads)
        return wait

    def _deliver(
        self, target_id: str, event: str, payloads: list[dict[str, Any]]
    ) -> None:
        target = targets.get_target(target_id)
        if target is None or not target.get("enabled"):
            return
        message = render(event, payloads)
        attempts = len(self._backoff) + 1
        for attempt in range(attempts):
            try:
                self._sender(target, message)
                return
            except DeliveryError as exc:
                last = attempt == attempts - 1
                if not exc.retryable or last:
                    logger.warning(
                        "notification %r to %r (%s) failed after %d attempt(s): %s",
                        event,
                        target.get("name"),
                        target.get("kind"),
                        attempt + 1,
                        exc,
                        exc_info=True,
                    )
                    return
                if self._pause(self._backoff[attempt]):
                    return

    def _pause(self, seconds: float) -> bool:
        """Wait before a retry; True when the worker was told to stop meanwhile."""
        worker = self._worker
        if worker is not None:
            return worker.sleep(seconds)
        time.sleep(seconds)
        return False

    # -- the worker ------------------------------------------------------------

    def _loop(self, worker: BackgroundWorker) -> None:
        while not worker.stopping:
            wait = IDLE_WAIT_SEC
            try:
                wait = self.pump()
                if self._clock() >= self._next_watch:
                    self._next_watch = self._clock() + WATCH_INTERVAL_SEC
                    for watch in self.watchers:
                        watch(self)
            except Exception:
                logger.warning("notification worker pass failed", exc_info=True)
            if worker.wait_for_wake(wait):
                break
        # Say what is still waiting rather than silently losing it.
        with self._lock:
            left = len(self._queue)
        if left:
            logger.info("stopping with %d notification(s) undelivered", left)

    def create_worker(self) -> BackgroundWorker:
        self._worker = BackgroundWorker("notifications", self._loop)
        return self._worker
