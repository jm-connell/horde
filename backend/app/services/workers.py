"""Lifecycle for Horde's background threads.

Every long-lived thread (scanner poller, metadata sync, AI, catalog, ...) is a
``BackgroundWorker`` registered on the ``WorkerRegistry`` that ``lifespan`` creates
and keeps on ``app.state.workers``. Shutdown signals every worker first and joins them
in reverse start order, so no thread is left running into interpreter teardown, and a
worker that refuses to stop is logged by name instead of vanishing silently.

Workers that are not a plain loop (the file watcher, the download queue, the sprite
pool) implement the same small ``ManagedWorker`` protocol and register alongside.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Protocol, runtime_checkable

from fastapi import Request

logger = logging.getLogger(__name__)

DEFAULT_STOP_TIMEOUT_SEC = 5.0
#: All joins together during shutdown (docker stop allows 30 s in the compose file).
TOTAL_STOP_TIMEOUT_SEC = 20.0


@runtime_checkable
class ManagedWorker(Protocol):
    """What the registry needs from anything it starts and stops."""

    name: str

    def start(self) -> None: ...

    def signal_stop(self) -> None:
        """Ask the worker to finish. Must return immediately."""

    def stop(self, timeout: float | None = None) -> bool:
        """Signal and join. True when the worker is no longer running."""

    @property
    def is_alive(self) -> bool: ...

    @property
    def healthy(self) -> bool:
        """Running, or finished its job on purpose. False after a crash or death."""


class BackgroundWorker:
    """A daemon thread that runs ``target(worker)`` until asked to stop.

    ``target`` is a loop that returns when ``worker.stop_event`` is set. It should
    pause with ``sleep`` / ``wait_for_wake`` rather than ``time.sleep`` so a stop
    request interrupts the pause at once.

    * ``stop_event``: set by ``stop()``. Callers that read an existing event elsewhere
      (the catalog's ``should_stop``) pass it in.
    * ``wake_event``: set by ``wake()`` to cut a ``wait_for_wake`` short (and by
      ``stop()``). Callers that already own such an event can pass it in.
    * ``on_stop``: extra action when a stop is requested (e.g. unblock a queue).
    """

    def __init__(
        self,
        name: str,
        target: Callable[[BackgroundWorker], None],
        *,
        stop_event: threading.Event | None = None,
        wake_event: threading.Event | None = None,
        on_stop: Callable[[], None] | None = None,
        stop_timeout: float = DEFAULT_STOP_TIMEOUT_SEC,
    ) -> None:
        self.name = name
        self.stop_timeout = stop_timeout
        self.stop_event = stop_event if stop_event is not None else threading.Event()
        self.wake_event = wake_event if wake_event is not None else threading.Event()
        self._target = target
        self._on_stop = on_stop
        self._thread: threading.Thread | None = None
        self._crashed = False

    def _run(self) -> None:
        try:
            self._target(self)
        except Exception:
            self._crashed = True
            logger.exception("background worker %s crashed", self.name)

    def start(self) -> None:
        if self.is_alive:
            return
        self.stop_event.clear()
        self._crashed = False
        self._thread = threading.Thread(target=self._run, name=self.name, daemon=True)
        self._thread.start()

    @property
    def is_alive(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()

    @property
    def healthy(self) -> bool:
        """Alive, or ended normally (a one-shot job such as the probe backfill)."""
        return self._thread is not None and (self.is_alive or not self._crashed)

    @property
    def stopping(self) -> bool:
        return self.stop_event.is_set()

    def signal_stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()
        if self._on_stop is not None:
            try:
                self._on_stop()
            except Exception:
                logger.warning("on_stop hook of %s failed", self.name, exc_info=True)

    def stop(self, timeout: float | None = None) -> bool:
        self.signal_stop()
        thread = self._thread
        if thread is None or thread is threading.current_thread():
            return True
        thread.join(self.stop_timeout if timeout is None else timeout)
        return not thread.is_alive()

    def wake(self) -> None:
        self.wake_event.set()

    def sleep(self, seconds: float) -> bool:
        """Pause up to ``seconds``. True when a stop was requested (caller returns)."""
        return self.stop_event.wait(seconds)

    def wait_for_wake(self, seconds: float) -> bool:
        """Pause until woken, stopped or ``seconds`` pass. True when stopping."""
        self.wake_event.wait(seconds)
        if not self.stop_event.is_set():
            self.wake_event.clear()
        return self.stop_event.is_set()


class CallbackWorker:
    """Adapts start/stop callables (file observer, queue shutdown) to the protocol."""

    def __init__(
        self,
        name: str,
        *,
        start: Callable[[], None],
        stop: Callable[[float], bool | None],
        is_alive: Callable[[], bool],
        signal_stop: Callable[[], None] | None = None,
        stop_timeout: float = DEFAULT_STOP_TIMEOUT_SEC,
    ) -> None:
        self.name = name
        self.stop_timeout = stop_timeout
        self._start = start
        self._stop = stop
        self._is_alive = is_alive
        self._signal_stop = signal_stop

    def start(self) -> None:
        self._start()

    @property
    def is_alive(self) -> bool:
        return self._is_alive()

    @property
    def healthy(self) -> bool:
        return self.is_alive

    def signal_stop(self) -> None:
        if self._signal_stop is not None:
            self._signal_stop()

    def stop(self, timeout: float | None = None) -> bool:
        self.signal_stop()
        self._stop(self.stop_timeout if timeout is None else timeout)
        return not self.is_alive


class WorkerRegistry:
    """Owns every started worker; stops them in reverse order on shutdown."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._workers: list[ManagedWorker] = []

    def start(self, worker: ManagedWorker) -> ManagedWorker:
        """Start ``worker`` and remember it. A failing start leaves it unregistered."""
        worker.start()
        with self._lock:
            self._workers.append(worker)
        logger.debug("started worker %s", worker.name)
        return worker

    @property
    def workers(self) -> list[ManagedWorker]:
        with self._lock:
            return list(self._workers)

    def status(self) -> dict[str, bool]:
        return {w.name: bool(w.healthy) for w in self.workers}

    def dead(self) -> list[str]:
        return [name for name, ok in self.status().items() if not ok]

    def stop_all(
        self,
        timeout: float | None = None,
        total_timeout: float = TOTAL_STOP_TIMEOUT_SEC,
    ) -> list[str]:
        """Stop every worker, newest first. Returns the names that did not stop.

        All workers are signalled before any is joined, so independent workers wind
        down in parallel and shutdown takes about as long as the slowest one. Each
        join waits at most the worker's own timeout (or ``timeout``) and never past
        ``total_timeout`` overall, so a pile of stuck workers cannot outlast the
        container's stop grace period.
        """
        with self._lock:
            workers = list(reversed(self._workers))
            self._workers.clear()
        logger.info("stopping %d background workers", len(workers))
        for worker in workers:
            try:
                worker.signal_stop()
            except Exception:
                logger.warning(
                    "signalling %s to stop failed", worker.name, exc_info=True
                )
        deadline = time.monotonic() + total_timeout
        stuck: list[str] = []
        for worker in workers:
            own = timeout
            if own is None:
                own = getattr(worker, "stop_timeout", DEFAULT_STOP_TIMEOUT_SEC)
            wait = max(0.1, min(own, deadline - time.monotonic()))
            try:
                stopped = worker.stop(wait)
            except Exception:
                logger.warning("stopping %s failed", worker.name, exc_info=True)
                stopped = False
            if stopped:
                logger.info("worker %s stopped", worker.name)
            else:
                stuck.append(worker.name)
                logger.error("worker %s did not stop within its timeout", worker.name)
        return stuck


def shutdown_requested(request: Request) -> bool:
    """True once the app is shutting down (long-lived streams should end)."""
    event = getattr(request.app.state, "shutdown_event", None)
    return event is not None and event.is_set()
