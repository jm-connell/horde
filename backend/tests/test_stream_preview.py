"""Tests for in-app stream preview helpers (no YouTube)."""

import threading
import time

import pytest

from app.services import stream_preview


def test_resolve_preview_stream_force_bypasses_cache(monkeypatch):
    calls = {"n": 0}

    def fake_extract(url, *, force=False):
        calls["n"] += 1
        return {
            "formats": [
                {
                    "url": f"https://cdn.example/{calls['n']}.mp4",
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                    "height": 720,
                    "ext": "mp4",
                    "tbr": 1000,
                    "http_headers": {"User-Agent": "test"},
                }
            ]
        }

    monkeypatch.setattr(stream_preview, "_extract_preview_info", fake_extract)
    stream_preview._preview_stream_cache.clear()
    url = "https://youtu.be/preview-cache-test"
    first = stream_preview.resolve_preview_stream(url)
    second = stream_preview.resolve_preview_stream(url)
    assert first["direct_url"] == second["direct_url"]
    assert calls["n"] == 1
    third = stream_preview.resolve_preview_stream(url, force=True)
    assert calls["n"] == 2
    assert third["direct_url"] != first["direct_url"]


URL = "https://youtu.be/build-once-test"


def _entry(token: str) -> dict:
    now = time.time()
    return {
        "token": token,
        "source_url": URL,
        "formats": {
            "299": {
                "direct_url": f"https://cdn.example/{token}.mp4",
                "http_headers": {},
                "content_type": "video/mp4",
            }
        },
        "extracted_at": now,
        "expires_at": now + 3600,
    }


@pytest.fixture
def builds(monkeypatch):
    """Empty manifest caches; ``_build_manifest_entry`` blocks until ``release``."""
    for name in (
        "_preview_manifest_by_url",
        "_preview_manifest_by_token",
        "_preview_refresh_inflight",
    ):
        monkeypatch.setattr(stream_preview, name, {})
    monkeypatch.setattr(
        stream_preview, "_extract_preview_info", lambda url, *, force=False: {}
    )
    state = {"calls": 0, "release": threading.Event(), "fail_first": False}

    def build(url, info):
        state["calls"] += 1
        call = state["calls"]
        state["release"].wait(5)
        if state["fail_first"] and call == 1:
            raise RuntimeError("probe failed")
        return _entry(f"tok{call}")

    monkeypatch.setattr(stream_preview, "_build_manifest_entry", build)
    return state


def _resolve_in_threads(builds, count=2):
    """Start ``count`` resolves, let the second get under way, then release."""
    results: list = [None] * count

    def run(i):
        try:
            results[i] = stream_preview.resolve_preview_manifest(URL)
        except RuntimeError as exc:  # the failing build; PreviewRefreshError too
            results[i] = exc

    threads = [threading.Thread(target=run, args=(i,)) for i in range(count)]
    threads[0].start()
    deadline = time.monotonic() + 5
    while builds["calls"] < 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    for t in threads[1:]:
        t.start()
    time.sleep(0.2)
    builds["release"].set()
    for t in threads:
        t.join(timeout=5)
    assert not any(t.is_alive() for t in threads)
    return results


def test_concurrent_resolves_build_once(builds):
    results = _resolve_in_threads(builds)

    assert builds["calls"] == 1
    assert [r["token"] for r in results] == ["tok1", "tok1"]
    media = stream_preview.lookup_preview_media("tok1", "299")
    assert media["direct_url"] == "https://cdn.example/tok1.mp4"


def test_a_waiter_builds_when_the_first_build_failed(builds):
    builds["fail_first"] = True

    first, second = _resolve_in_threads(builds)

    assert isinstance(first, RuntimeError)
    assert second["token"] == "tok2"
    assert builds["calls"] == 2


def test_waiting_for_a_stuck_build_gives_up(builds, monkeypatch):
    monkeypatch.setattr(stream_preview, "_PREVIEW_BUILD_FOLLOW_WAIT_SEC", 0.05)
    monkeypatch.setitem(
        stream_preview._preview_refresh_inflight, URL, threading.Event()
    )

    with pytest.raises(stream_preview.PreviewRefreshError) as caught:
        stream_preview.resolve_preview_manifest(URL)

    assert caught.value.retry_after == 5


def test_browsing_does_not_evict_the_stream_being_played(builds):
    """Warm-ups add manifests; the cache must not drop the one a player uses."""

    def entry(url: str, token: str) -> dict:
        return {**_entry(token), "source_url": url}

    playing = "https://youtu.be/playing"
    stream_preview._store_manifest_entry(playing, entry(playing, "playing"))
    for i in range(60):
        hovered = f"https://youtu.be/hovered-{i}"
        stream_preview._store_manifest_entry(hovered, entry(hovered, f"tok-{i}"))
        # The player keeps fetching segments of the stream it plays.
        stream_preview.lookup_preview_media("playing", "299")

    media = stream_preview.lookup_preview_media("playing", "299")
    assert media["direct_url"] == "https://cdn.example/playing.mp4"


def test_browsing_does_not_evict_a_paused_stream(builds):
    """A paused player fetches nothing, but its session must outlast warm-ups."""

    def entry(url: str, token: str) -> dict:
        return {**_entry(token), "source_url": url}

    paused = "https://youtu.be/paused"
    stream_preview._store_manifest_entry(paused, entry(paused, "paused"))
    stream_preview.lookup_preview_media("paused", "299")
    for i in range(60):
        hovered = f"https://youtu.be/hovered-{i}"
        stream_preview._store_manifest_entry(hovered, entry(hovered, f"tok-{i}"))

    media = stream_preview.lookup_preview_media("paused", "299")
    assert media["direct_url"] == "https://cdn.example/paused.mp4"
