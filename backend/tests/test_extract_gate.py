import threading
import time

import pytest

from app.services import ytdlp_common


def test_interactive_extract_jumps_background_waiters():
    ytdlp_common._extract_held = False
    ytdlp_common._extract_waiters.clear()
    ytdlp_common._extract_waiter_seq = 0

    order: list[str] = []
    ytdlp_common._acquire_extract_gate(ytdlp_common.EXTRACT_PRIORITY_DOWNLOAD)

    def background() -> None:
        ytdlp_common._acquire_extract_gate(ytdlp_common.EXTRACT_PRIORITY_BACKGROUND)
        order.append("bg")
        ytdlp_common._release_extract_gate()

    def interactive() -> None:
        ytdlp_common._acquire_extract_gate(ytdlp_common.EXTRACT_PRIORITY_INTERACTIVE)
        order.append("fg")
        ytdlp_common._release_extract_gate()

    bg = threading.Thread(target=background)
    fg = threading.Thread(target=interactive)
    bg.start()
    time.sleep(0.05)
    fg.start()
    time.sleep(0.05)
    ytdlp_common._release_extract_gate()
    bg.join(timeout=2)
    fg.join(timeout=2)
    try:
        assert order == ["fg", "bg"]
    finally:
        ytdlp_common._extract_held = False
        ytdlp_common._extract_waiters.clear()


def test_a_waiter_gives_up_instead_of_blocking_forever():
    ytdlp_common._extract_held = False
    ytdlp_common._extract_waiters.clear()
    ytdlp_common._acquire_extract_gate(ytdlp_common.EXTRACT_PRIORITY_DOWNLOAD)
    try:
        started = time.monotonic()
        with pytest.raises(ytdlp_common.ExtractQueueTimeout, match="Gave up waiting"):
            ytdlp_common._acquire_extract_gate(
                ytdlp_common.EXTRACT_PRIORITY_INTERACTIVE, timeout=0.2
            )
        assert time.monotonic() - started < 2
        # The abandoned waiter left the queue, so the next release frees the gate.
        assert ytdlp_common._extract_waiters == []
    finally:
        ytdlp_common._release_extract_gate()
    assert ytdlp_common._extract_held is False


def test_background_waiters_get_the_longer_timeout(monkeypatch):
    seen: list[float] = []

    class RecordingEvent(threading.Event):
        def wait(self, timeout=None):
            seen.append(timeout)
            return False

    monkeypatch.setattr(ytdlp_common.threading, "Event", RecordingEvent)
    monkeypatch.setattr(ytdlp_common, "EXTRACT_QUEUE_TIMEOUT_SEC", 10.0)
    monkeypatch.setattr(ytdlp_common, "EXTRACT_QUEUE_TIMEOUT_BACKGROUND_SEC", 30.0)
    ytdlp_common._extract_held = True
    ytdlp_common._extract_waiters.clear()
    try:
        for priority in (
            ytdlp_common.EXTRACT_PRIORITY_INTERACTIVE,
            ytdlp_common.EXTRACT_PRIORITY_DOWNLOAD,
            ytdlp_common.EXTRACT_PRIORITY_BACKGROUND,
        ):
            with pytest.raises(ytdlp_common.ExtractQueueTimeout):
                ytdlp_common._acquire_extract_gate(priority)
    finally:
        ytdlp_common._extract_held = False
        ytdlp_common._extract_waiters.clear()
    assert seen == [10.0, 10.0, 30.0]
