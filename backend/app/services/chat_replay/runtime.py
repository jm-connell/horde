"""Chat replay state held on ``AppContext.chat_replay``: tokens, chunks, the pause."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .youtube import Chunk, Opened

#: An open chat (tokens, innertube config) is dropped after this long unused.
OPEN_TTL_SEC = 30 * 60
#: How long "no chat replay" is remembered.
NONE_TTL_SEC = 6 * 3600
#: Open chats kept at once.
OPEN_KEEP = 200
#: How long a fetched chunk is served from memory.
CHUNK_TTL_SEC = 30 * 60
#: Chunks kept at once (each is 50-100 messages).
CHUNK_KEEP = 400
#: A rate limit or bot check stops every chat replay read this long.
PAUSE_ON_LIMIT_SEC = 30 * 60


@dataclass
class ChatReplayRuntime:
    _lock: threading.Lock = field(default_factory=threading.Lock)
    #: Monotonic time before which no chat replay read reaches YouTube.
    _paused_until: float = 0.0
    #: YouTube id -> (monotonic time stored or last used, opened chat).
    _opened: dict[str, tuple[float, Opened]] = field(default_factory=dict)
    #: (YouTube id, "at:<bucket>" | "next:<token>") -> (monotonic time, chunk).
    _chunks: dict[tuple[str, str], tuple[float, Chunk]] = field(default_factory=dict)
    #: One read per video at a time: viewers of the same video share fetches.
    _video_locks: dict[str, threading.Lock] = field(default_factory=dict)

    def pause(self, seconds: float) -> None:
        with self._lock:
            self._paused_until = max(self._paused_until, time.monotonic() + seconds)

    def seconds_paused(self) -> float:
        with self._lock:
            return max(0.0, self._paused_until - time.monotonic())

    def video_lock(self, yt_id: str) -> threading.Lock:
        with self._lock:
            for key in [k for k in self._video_locks if k not in self._opened]:
                if not self._video_locks[key].locked():
                    del self._video_locks[key]
            return self._video_locks.setdefault(yt_id, threading.Lock())

    def opened_get(self, yt_id: str) -> Opened | None:
        with self._lock:
            hit = self._opened.get(yt_id)
            if hit is None:
                return None
            stamp, opened = hit
            ttl = NONE_TTL_SEC if opened.handle is None else OPEN_TTL_SEC
            now = time.monotonic()
            if now - stamp > ttl:
                del self._opened[yt_id]
                return None
            if opened.handle is not None:
                # Idle time counts from the last read.
                self._opened[yt_id] = (now, opened)
            return opened

    def opened_put(self, yt_id: str, opened: Opened) -> None:
        with self._lock:
            self._opened[yt_id] = (time.monotonic(), opened)
            while len(self._opened) > OPEN_KEEP:
                oldest = min(self._opened, key=lambda k: self._opened[k][0])
                del self._opened[oldest]

    def opened_drop(self, yt_id: str) -> None:
        with self._lock:
            self._opened.pop(yt_id, None)

    def chunk_get(self, key: tuple[str, str]) -> Chunk | None:
        with self._lock:
            hit = self._chunks.get(key)
            if hit is None:
                return None
            if time.monotonic() - hit[0] > CHUNK_TTL_SEC:
                del self._chunks[key]
                return None
            return hit[1]

    def chunk_put(self, key: tuple[str, str], chunk: Chunk) -> None:
        with self._lock:
            self._chunks[key] = (time.monotonic(), chunk)
            while len(self._chunks) > CHUNK_KEEP:
                oldest = min(self._chunks, key=lambda k: self._chunks[k][0])
                del self._chunks[oldest]
