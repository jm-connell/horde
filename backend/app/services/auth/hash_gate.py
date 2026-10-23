"""A cap on password hashes running at once.

A scrypt hash takes about 100 ms and 32 MiB. Request threads that all start one
together (a burst of sign-ins from anywhere, which needs no account) would fill
the shared worker pool and the memory with hashing and starve every other
request. ``HashGate`` lets ``size`` hashes run at a time; a request that cannot
get a slot within ``WAIT_SEC`` is answered 503 ``busy`` with ``Retry-After: 1``
instead of queueing. It guards every path that hashes, including the stand-in
hash for an unknown username, so an unknown name costs the same as a known one.

One lives on the ``AuthRuntime``; the size is the number of CPUs (at least 2).
"""

from __future__ import annotations

import os
import threading
from collections.abc import Iterator
from contextlib import contextmanager

from ...errors import CodedHTTPException

#: How long a request waits for a slot before it is turned away.
WAIT_SEC = 0.25


def default_size() -> int:
    return max(2, os.cpu_count() or 2)


class HashGate:
    def __init__(self, size: int | None = None, wait: float = WAIT_SEC) -> None:
        self._slots = threading.BoundedSemaphore(size or default_size())
        self._wait = wait

    @contextmanager
    def slot(self) -> Iterator[None]:
        """Hold a hashing slot for the block, or raise 503 ``busy``."""
        if not self._slots.acquire(timeout=self._wait):
            raise CodedHTTPException(
                503,
                "The server is busy. Try again in a moment.",
                "busy",
                headers={"Retry-After": "1"},
            )
        try:
            yield
        finally:
            self._slots.release()
