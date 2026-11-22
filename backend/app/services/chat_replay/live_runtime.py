"""Live chat state on ``AppContext.live_chat``: one poller and buffer per broadcast.

The first read of a broadcast opens its chat (in the request) and starts a
daemon thread that polls YouTube at the pace it asks for. Every viewer reads
the same buffer, filtered at the moment they are watching (``cutoff_ms``, a
send time) and after the last message they have (``after``, a sequence
number). Polling stops ``READ_IDLE_SEC`` after the last read, when the
broadcast ends (no further token), on a rate limit (which pauses every chat
read through ``ChatReplayRuntime``) or at shutdown; the buffer is still served,
and a later read restarts polling where it left off. A buffer nobody has read
for ``BUFFER_IDLE_SEC`` is dropped.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from ...config import LIVE_DVR_WINDOW_SEC
from ...context import current
from ..comments.fetch import FAILED, LATER, RETRY, UNAVAILABLE
from . import live
from .parse import ChatItem
from .runtime import PAUSE_ON_LIMIT_SEC, ChatReplayRuntime
from .youtube import ChatHandle, ChatReplayError

logger = logging.getLogger(__name__)

#: Polling stops this long after the last read (a background tab reads about
#: once a minute; the next read restarts it).
READ_IDLE_SEC = 60.0
#: A buffer nobody has read for this long is dropped.
BUFFER_IDLE_SEC = 600.0
#: Messages kept per broadcast (also at most the DVR window of send time).
MAX_MESSAGES = 20_000
#: Bounds on YouTube's ``timeoutMs`` between polls.
MIN_POLL_SEC = 2.0
MAX_POLL_SEC = 30.0


@dataclass
class LiveChatPage:
    status: Literal["ok", "none", "unavailable"]
    items: list[ChatItem]
    removed: list[str]
    next_after: int
    earliest_ms: int | None


def poll_interval(timeout_ms: int) -> float:
    return min(MAX_POLL_SEC, max(MIN_POLL_SEC, timeout_ms / 1000))


@dataclass
class LiveChat:
    """One broadcast's chat: its buffer and its poller."""

    yt_id: str
    lock: threading.Lock = field(default_factory=threading.Lock)
    #: None until opened; then ``ok``, ``none`` or ``unavailable``.
    status: str | None = None
    handle: ChatHandle | None = None
    token: str | None = None
    timeout_ms: int = 10_000
    #: (sequence, message), in arrival order.
    items: list[tuple[int, ChatItem]] = field(default_factory=list)
    #: (sequence, deleted id).
    removed: list[tuple[int, str]] = field(default_factory=list)
    seq: int = 0
    ended: bool = False
    #: Open afresh on the next read (the tokens may be what failed).
    reopen: bool = False
    last_read: float = 0.0
    opened_at: float = field(default_factory=time.monotonic)
    thread: threading.Thread | None = None
    stop: threading.Event = field(default_factory=threading.Event)

    def add(self, poll: live.LivePoll, max_age_ms: int) -> None:
        """Append a poll's messages and deletions (caller holds ``lock``)."""
        known = {item.id for _, item in self.items}
        for item in poll.items:
            if item.id not in known:
                self.seq += 1
                self.items.append((self.seq, item))
        if poll.removed:
            gone = set(poll.removed)
            self.items = [(s, i) for s, i in self.items if i.id not in gone]
            for target in poll.removed:
                self.seq += 1
                self.removed.append((self.seq, target))
        newest = max((i.offset_ms for _, i in self.items), default=0)
        self.items = [
            (s, i) for s, i in self.items if newest - i.offset_ms <= max_age_ms
        ][-MAX_MESSAGES:]
        self.removed = self.removed[-MAX_MESSAGES:]
        self.token = poll.token
        self.timeout_ms = poll.timeout_ms
        if poll.token is None:
            self.ended = True

    def page(self, cutoff_ms: int, after: int, limit: int) -> LiveChatPage:
        """Messages after ``after`` up to the first one sent past ``cutoff_ms``."""
        shown: list[ChatItem] = []
        next_after = after
        for seq, item in self.items:
            if seq <= after:
                continue
            if item.offset_ms > cutoff_ms:
                break
            shown.append(item)
            next_after = seq
        removed = [target for seq, target in self.removed if seq > after]
        earliest = min((i.offset_ms for _, i in self.items), default=None)
        return LiveChatPage("ok", shown[-limit:], removed, next_after, earliest)


@dataclass
class LiveChatRuntime:
    clock: Callable[[], float] = time.monotonic
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _chats: dict[str, LiveChat] = field(default_factory=dict)

    def polling(self, yt_id: str) -> bool:
        with self._lock:
            chat = self._chats.get(yt_id)
        return bool(chat and chat.thread and chat.thread.is_alive())

    def _chat(self, yt_id: str) -> LiveChat:
        now = self.clock()
        with self._lock:
            for key, chat in list(self._chats.items()):
                idle = now - chat.last_read > BUFFER_IDLE_SEC
                if (
                    key != yt_id
                    and idle
                    and not (chat.thread and chat.thread.is_alive())
                ):
                    del self._chats[key]
            return self._chats.setdefault(yt_id, LiveChat(yt_id))

    def read(
        self, yt_id: str, cutoff_ms: int, after: int, limit: int = 300
    ) -> LiveChatPage:
        """What a viewer at ``cutoff_ms`` gets after ``after``. Raises
        ``ChatReplayError`` (``RETRY``, ``LATER``, ``FAILED``) only while the
        chat has never opened."""
        ctx = current()
        if ctx.e2e:
            # The browser suite mocks this route; the server never reaches YouTube.
            return LiveChatPage("none", [], [], after, None)
        replay = ctx.chat_replay
        chat = self._chat(yt_id)
        with chat.lock:
            chat.last_read = self.clock()
            if chat.status is None or chat.reopen:
                self._open(chat, replay)
            if chat.status != "ok":
                if chat.status == "unavailable":
                    return LiveChatPage("unavailable", [], [], after, None)
                return LiveChatPage("none", [], [], after, None)
            if (
                not chat.ended
                and replay.seconds_paused() == 0
                and not (chat.thread and chat.thread.is_alive())
            ):
                self._start(chat, replay)
            return chat.page(cutoff_ms, after, limit)

    def _open(self, chat: LiveChat, replay: ChatReplayRuntime) -> None:
        if replay.seconds_paused() > 0:
            if chat.status is None:
                raise ChatReplayError(RETRY)
            return  # keep serving what is held
        try:
            handle, first, live_status = live.open_live_chat(chat.yt_id)
        except ChatReplayError as exc:
            if exc.status == UNAVAILABLE:
                chat.status = "unavailable"
                return
            if exc.status == RETRY:
                replay.pause(PAUSE_ON_LIMIT_SEC)
            if chat.status is None:
                raise
            return  # a reopen failed: keep serving what is held
        chat.reopen = False
        if handle is None or first is None or live_status != "is_live":
            if chat.status is None:
                chat.status = "none"
            chat.ended = chat.status == "ok"
            return
        chat.handle = handle
        chat.status = "ok"
        chat.ended = False
        chat.add(first, int(LIVE_DVR_WINDOW_SEC * 1000))

    def _start(self, chat: LiveChat, replay: ChatReplayRuntime) -> None:
        chat.stop = threading.Event()
        chat.opened_at = self.clock()
        chat.thread = threading.Thread(
            target=self._poll_loop,
            args=(chat, replay),
            name=f"live-chat-{chat.yt_id}",
            daemon=True,
        )
        chat.thread.start()

    def _poll_loop(self, chat: LiveChat, replay: ChatReplayRuntime) -> None:
        max_age_ms = int(LIVE_DVR_WINDOW_SEC * 1000)
        while not chat.stop.wait(poll_interval(chat.timeout_ms)):
            with chat.lock:
                idle = self.clock() - chat.last_read > READ_IDLE_SEC
                handle, token = chat.handle, chat.token
            if idle or replay.seconds_paused() > 0 or handle is None or token is None:
                return
            offset_ms = int((self.clock() - chat.opened_at) * 1000)
            try:
                poll = live.poll_live_chat(handle, token, offset_ms)
            except ChatReplayError as exc:
                if exc.status == LATER:
                    continue  # YouTube out of reach: try again next time
                if exc.status == RETRY:
                    replay.pause(PAUSE_ON_LIMIT_SEC)
                elif exc.status == FAILED:
                    with chat.lock:
                        chat.reopen = True
                return
            except Exception:
                logger.warning("Live chat poll of %s failed", chat.yt_id, exc_info=True)
                with chat.lock:
                    chat.reopen = True
                return
            with chat.lock:
                chat.add(poll, max_age_ms)
                if chat.ended:
                    return

    def stop_all(self, timeout: float = 5.0) -> None:
        with self._lock:
            chats = list(self._chats.values())
        for chat in chats:
            chat.stop.set()
        for chat in chats:
            if chat.thread is not None:
                chat.thread.join(timeout)
