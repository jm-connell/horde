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


def test_slow_gated_requests_are_logged(monkeypatch, caplog):
    """A request that held the gate long names itself, so stalls can be traced."""
    ytdlp_common._extract_held = False
    ytdlp_common._extract_waiters.clear()
    monkeypatch.setattr(ytdlp_common, "_last_extract_at", 0.0)
    url = "https://www.youtube.com/watch?v=slowslowslo"

    with caplog.at_level("WARNING", logger=ytdlp_common.logger.name):
        ytdlp_common.call_gated(lambda: None, url=url)
    assert "Slow YouTube request" not in caplog.text

    monkeypatch.setattr(ytdlp_common, "SLOW_EXTRACT_RUN_SEC", 0.0)
    with caplog.at_level("WARNING", logger=ytdlp_common.logger.name):
        ytdlp_common.call_gated(
            lambda: None, url=url, priority=ytdlp_common.EXTRACT_PRIORITY_INTERACTIVE
        )
    assert "Slow YouTube request (interactive)" in caplog.text
    assert url in caplog.text
    assert ytdlp_common._extract_held is False

    # Background requests queue behind everything by design: debug, not warning.
    caplog.clear()
    with caplog.at_level("WARNING", logger=ytdlp_common.logger.name):
        ytdlp_common.call_gated(
            lambda: None, url=url, priority=ytdlp_common.EXTRACT_PRIORITY_BACKGROUND
        )
    assert "Slow YouTube request" not in caplog.text


def _hold_gate_in_thread(url: str, priority: int, release: threading.Event):
    def hold() -> None:
        ytdlp_common._acquire_extract_gate(priority, url=url)
        release.wait(5)
        ytdlp_common._release_extract_gate()

    thread = threading.Thread(target=hold)
    thread.start()
    deadline = time.monotonic() + 2
    while ytdlp_common._extract_holder is None and time.monotonic() < deadline:
        time.sleep(0.01)
    return thread


def test_a_long_wait_names_the_request_holding_the_queue(monkeypatch, caplog):
    """A stalled preview logs what holds the queue, even if that never finishes."""
    ytdlp_common._extract_held = False
    ytdlp_common._extract_waiters.clear()
    monkeypatch.setattr(ytdlp_common, "SLOW_EXTRACT_WAIT_SEC", 0.05)
    holder_url = "https://www.youtube.com/@somechannel/videos"
    waiter_url = "https://www.youtube.com/watch?v=waitingwait"
    release = threading.Event()
    holder = _hold_gate_in_thread(
        holder_url, ytdlp_common.EXTRACT_PRIORITY_BACKGROUND, release
    )
    try:
        with (
            caplog.at_level("WARNING", logger=ytdlp_common.logger.name),
            pytest.raises(ytdlp_common.ExtractQueueTimeout),
        ):
            ytdlp_common._acquire_extract_gate(
                ytdlp_common.EXTRACT_PRIORITY_INTERACTIVE,
                timeout=0.3,
                url=waiter_url,
            )
    finally:
        release.set()
        holder.join(timeout=5)
    assert "held by a background request" in caplog.text
    assert holder_url in caplog.text
    assert waiter_url in caplog.text
    assert ytdlp_common._extract_held is False
    assert ytdlp_common._extract_holder is None


def test_background_waiters_do_not_report_the_holder(monkeypatch, caplog):
    ytdlp_common._extract_held = False
    ytdlp_common._extract_waiters.clear()
    monkeypatch.setattr(ytdlp_common, "SLOW_EXTRACT_WAIT_SEC", 0.05)
    release = threading.Event()
    holder = _hold_gate_in_thread(
        "https://www.youtube.com/watch?v=holderholdr",
        ytdlp_common.EXTRACT_PRIORITY_DOWNLOAD,
        release,
    )
    try:
        with (
            caplog.at_level("WARNING", logger=ytdlp_common.logger.name),
            pytest.raises(ytdlp_common.ExtractQueueTimeout),
        ):
            ytdlp_common._acquire_extract_gate(
                ytdlp_common.EXTRACT_PRIORITY_BACKGROUND, timeout=0.2
            )
    finally:
        release.set()
        holder.join(timeout=5)
    assert "held by" not in caplog.text
