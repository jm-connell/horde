"""A cap on password hashes running at once.

A scrypt hash takes about 100 ms and 32 MiB. Request threads that all start one
together (a burst of sign-ins from anywhere, which needs no account) would fill
the shared worker pool and the memory with hashing and starve every other
request. ``HashGate`` lets ``size`` hashes run at a time; a request that cannot
get a slot within ``WAIT_SEC`` is answered 503 ``busy`` with ``Retry-After: 1``
instead of queueing. It guards every path that hashes, including the stand-in
hash for an unknown username, so an unknown name costs the same as a known one.

The cap itself could be used to keep people out, so it is not shared equally:

* one slot is **reserved** for a sign-in from a known device (a valid
  ``horde_device`` cookie, see ``device_cookie.py``), so the owner on their own
  browser always gets judged, however much junk is queued;
* attempts on **made-up names** (they hash a stand-in and can never succeed) may
  hold only about half the slots between them.

One lives on the ``AuthRuntime``; the size is the number of CPUs (at least 2).
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

from ...errors import CodedHTTPException

#: How long a request waits for a slot before it is turned away.
WAIT_SEC = 0.25


def default_size() -> int:
    return max(2, os.cpu_count() or 2)


class HashGate:
    def __init__(self, size: int | None = None, wait: float = WAIT_SEC) -> None:
        self._size = size or default_size()
        self._wait = wait
        self._cond = threading.Condition()
        self._used = 0
        self._made_up = 0
        #: Ordinary requests leave one slot for a known device (when there are two or more).
        self._open_limit = max(1, self._size - 1)
        self._made_up_limit = max(1, self._size // 2)

    def _free(self, known_device: bool, made_up: bool) -> bool:
        if self._used >= (self._size if known_device else self._open_limit):
            return False
        return not (made_up and self._made_up >= self._made_up_limit)

    @contextmanager
    def slot(
        self, *, known_device: bool = False, made_up: bool = False
    ) -> Iterator[None]:
        """Hold a hashing slot for the block, or raise 503 ``busy``.

        ``known_device``: the caller holds a valid device cookie for the account
        (may use the reserved slot). ``made_up``: the name belongs to no account.
        """
        deadline = time.monotonic() + self._wait
        with self._cond:
            while not self._free(known_device, made_up):
                left = deadline - time.monotonic()
                if left <= 0:
                    raise CodedHTTPException(
                        503,
                        "The server is busy. Try again in a moment.",
                        "busy",
                        headers={"Retry-After": "1"},
                    )
                self._cond.wait(left)
            self._used += 1
            if made_up:
                self._made_up += 1
        try:
            yield
        finally:
            with self._cond:
                self._used -= 1
                if made_up:
                    self._made_up -= 1
                self._cond.notify_all()
