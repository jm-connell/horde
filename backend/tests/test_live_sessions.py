"""Live HLS sessions against a simulated YouTube (no network).

``FakeYouTube`` serves a live broadcast the way googlevideo does: a media
playlist of the newest segments whose URLs carry ``/sq/<n>/`` and a signature
tied to the current extraction. Old signatures start answering 403 when the
test "expires" them, segments before ``dvr_floor`` answer 404, and the
broadcast can end.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx
import pytest

from app.services.live import sessions as live
from app.services.live.sessions import (
    LiveNotAvailable,
    LiveSegmentMissing,
    LiveSession,
    LiveSessionManager,
)

VID = "abcdefghijk"


class Clock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


class FakeYouTube:
    def __init__(self, *, head: int = 1000, window: int = 4, dvr_floor: int = 0):
        self.head = head
        self.window = window
        self.dvr_floor = dvr_floor
        self.generation = 1
        self.valid_generations = {1}
        self.live = True
        self.ended_playlist = False
        self.resolves: list[bool] = []
        self.fetches: list[str] = []
        self.playlist_status: int | None = None

    # yt-dlp
    def info(self) -> dict[str, Any]:
        return {
            "id": VID,
            "title": "Speedrun",
            "is_live": self.live,
            "live_status": "is_live" if self.live else "was_live",
            "formats": [
                {
                    "format_id": "95",
                    "protocol": "m3u8_native",
                    "url": f"https://manifest.example/g{self.generation}/expire/1900000000/itag/95/index.m3u8",
                    "vcodec": "avc1.4d401f",
                    "acodec": "mp4a.40.2",
                    "height": 720,
                    "width": 1280,
                    "tbr": 2500,
                    "fps": 30,
                },
                {  # video-only formats are skipped
                    "format_id": "136",
                    "protocol": "https",
                    "url": "https://x.example/136",
                    "vcodec": "avc1",
                    "acodec": "none",
                    "height": 720,
                },
            ],
        }

    async def resolve(self, url: str, force: bool) -> dict[str, Any]:
        self.resolves.append(force)
        if force:
            self.generation += 1
            self.valid_generations.add(self.generation)
        return self.info()

    def seg_url(self, sq: int, gen: int | None = None) -> str:
        g = self.generation if gen is None else gen
        return f"https://rr1.googlevideo.com/videoplayback/sig/g{g}/sq/{sq}/file/seg.ts"

    async def fetch(
        self, url: str, headers: dict[str, str], stream: bool
    ) -> httpx.Response:
        self.fetches.append(url)
        req = httpx.Request("GET", url)
        gen_match = re.search(r"/g(\d+)/", url) or re.search(r"/sig/g(\d+)/", url)
        gen = int(gen_match.group(1)) if gen_match else 0
        if gen not in self.valid_generations:
            return httpx.Response(403, request=req)
        if "manifest.example" in url:
            if self.playlist_status is not None:
                return httpx.Response(self.playlist_status, request=req)
            lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:5"]
            first = max(0, self.head - self.window + 1)
            lines.append(f"#EXT-X-MEDIA-SEQUENCE:{first}")
            for sq in range(first, self.head + 1):
                lines += ["#EXTINF:5.0,", self.seg_url(sq, gen)]
            if self.ended_playlist:
                lines.append("#EXT-X-ENDLIST")
            return httpx.Response(200, text="\n".join(lines), request=req)
        sq = int(re.search(r"/sq/(\d+)/", url).group(1))  # type: ignore[union-attr]  # test URLs always carry sq
        if sq < self.dvr_floor or sq > self.head:
            return httpx.Response(404, request=req)
        return httpx.Response(200, content=f"seg-{sq}".encode(), request=req)


def _session(yt: FakeYouTube, clock: Clock, *, dvr_sec: float = 3600) -> LiveSession:
    return LiveSession.from_info(
        VID,
        yt.info(),
        fetcher=yt.fetch,
        resolver=yt.resolve,
        dvr_window_sec=dvr_sec,
        clock=clock,
    )


def _sqs(playlist: str) -> list[int]:
    return [int(m) for m in re.findall(r"\.\./seg/95/(\d+)\.ts", playlist)]


async def _drain(session: LiveSession) -> None:
    """Let background tasks (DVR probe, refreshes) finish."""
    for _ in range(20):
        if not session._tasks:
            return
        await asyncio.gather(*list(session._tasks), return_exceptions=True)


def run(coro):
    return asyncio.run(coro)


def test_master_lists_the_muxed_hls_variant_only():
    yt, clock = FakeYouTube(), Clock()
    body = _session(yt, clock).master()
    assert body.count("#EXT-X-STREAM-INF") == 1
    assert "RESOLUTION=1280x720" in body
    assert 'CODECS="avc1.4d401f,mp4a.40.2"' in body
    assert "v/95.m3u8" in body


def test_not_live_or_no_hls_is_refused():
    yt = FakeYouTube()
    yt.live = False
    with pytest.raises(LiveNotAvailable):
        _session(yt, Clock())
    info = FakeYouTube().info()
    info["formats"] = [f for f in info["formats"] if f["protocol"] == "https"]
    with pytest.raises(LiveNotAvailable):
        LiveSession.from_info(
            VID, info, fetcher=yt.fetch, resolver=yt.resolve, dvr_window_sec=0
        )


def test_media_playlist_without_dvr_is_the_seen_window():
    async def go():
        yt, clock = FakeYouTube(head=1000, window=4), Clock()
        s = _session(yt, clock, dvr_sec=0)
        first = await s.media("95")
        assert _sqs(first) == [997, 998, 999, 1000]
        assert "#EXT-X-MEDIA-SEQUENCE:997" in first
        # The broadcast moves on; what was seen stays listed (contiguous).
        yt.head = 1002
        clock.now += 10
        second = await s.media("95")
        assert _sqs(second) == list(range(997, 1003))

    run(go())


def test_playlist_fetch_is_shared_between_rapid_requests():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        await asyncio.gather(*(s.media("95") for _ in range(5)))
        playlists = [u for u in yt.fetches if "manifest.example" in u]
        assert len(playlists) == 1

    run(go())


def test_dvr_probe_extends_the_playlist_back_to_what_youtube_keeps():
    async def go():
        # One hour window of 5 s segments = 720; YouTube keeps from sq 600.
        yt, clock = FakeYouTube(head=1000, window=4, dvr_floor=600), Clock()
        s = _session(yt, clock, dvr_sec=3600)
        body = await s.media("95")  # the first playlist already has the window
        assert s.template_ok is True
        assert s.dvr_floor is not None and 600 <= s.dvr_floor <= 1000 - 4
        sqs = _sqs(body)
        assert sqs[0] == s.dvr_floor and sqs[-1] == 1000
        assert sqs == list(range(sqs[0], 1001))
        # A backfilled segment is fetched through the template.
        resp = await s.segment("95", s.dvr_floor)
        assert resp.content == f"seg-{s.dvr_floor}".encode()

    run(go())


class SplitYouTube(FakeYouTube):
    """Video-only and audio-only formats (how YouTube serves most broadcasts
    now); every fetch yields so concurrent playlist requests interleave."""

    def info(self) -> dict[str, Any]:
        info = super().info()
        manifest = info["formats"][0]["url"]
        info["formats"] = [
            {
                "format_id": "232",
                "protocol": "m3u8_native",
                "url": manifest.replace("/itag/95/", "/itag/232/"),
                "vcodec": "avc1.4D401F",
                "acodec": "none",
                "height": 720,
                "width": 1280,
                "tbr": 2400,
            },
            {
                "format_id": "234",
                "protocol": "m3u8_native",
                "url": manifest.replace("/itag/95/", "/itag/234/"),
                "vcodec": "none",
                "acodec": None,
            },
        ]
        return info

    async def fetch(
        self, url: str, headers: dict[str, str], stream: bool
    ) -> httpx.Response:
        await asyncio.sleep(0)
        return await super().fetch(url, headers, stream)


def test_split_audio_and_video_playlists_start_at_the_same_segment():
    async def go():
        yt, clock = SplitYouTube(head=1000, window=4, dvr_floor=600), Clock()
        s = _session(yt, clock, dvr_sec=3600)
        assert "v/234.m3u8" in s.master() and 'AUDIO="audio"' in s.master()
        # The player asks for both playlists at once; the second must not
        # render before the DVR probe the first one started has finished.
        video, audio = await asyncio.gather(s.media("232"), s.media("234"))
        first = [
            int(ln.split(":")[1])
            for ln in (video, audio)
            for ln in ln.splitlines()
            if ln.startswith("#EXT-X-MEDIA-SEQUENCE:")
        ]
        assert first[0] == first[1] == s.dvr_floor
        assert "../seg/234/1000.aac" in audio
        assert "../seg/232/1000.ts" in video

    run(go())


def test_dvr_window_is_capped_and_starts_at_zero_for_a_young_stream():
    async def go():
        yt, clock = FakeYouTube(head=50, window=4), Clock()
        s = _session(yt, clock, dvr_sec=3600)
        await s.media("95")
        await _drain(s)
        assert s.dvr_floor == 0
        clock.now += 10
        assert _sqs(await s.media("95"))[0] == 0

        yt2, clock2 = FakeYouTube(head=100_000, window=4), Clock()
        s2 = _session(yt2, clock2, dvr_sec=600)  # 120 segments
        await s2.media("95")
        await _drain(s2)
        clock2.now += 10
        sqs = _sqs(await s2.media("95"))
        assert len(sqs) == 121 and sqs[-1] == 100_000

    run(go())


def test_no_dvr_when_earlier_segments_are_gone():
    async def go():
        yt, clock = FakeYouTube(head=1000, window=4, dvr_floor=1000), Clock()
        s = _session(yt, clock, dvr_sec=3600)
        await s.media("95")
        await _drain(s)
        assert s.template_ok is False
        clock.now += 10
        assert _sqs(await s.media("95"))[0] == 997

    run(go())


def test_expired_urls_are_refreshed_transparently():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        await s.media("95")
        # YouTube revokes every URL from the first extraction.
        yt.valid_generations = set()
        clock.now += 30
        resp = await s.segment("95", 1000)
        assert resp.status_code == 200 and resp.content == b"seg-1000"
        assert yt.resolves == [True]
        yt.head = 1001
        clock.now += 10
        assert 1001 in _sqs(await s.media("95"))

    run(go())


def test_playlist_403_refreshes_once_then_serves():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        await s.media("95")
        yt.valid_generations = {99}  # everything 403s until re-extracted
        clock.now += 30
        body = await s.media("95")
        assert _sqs(body)[-1] == 1000
        assert yt.resolves == [True]

    run(go())


def test_refreshes_are_debounced():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        clock.now += 30
        assert await s.reresolve(reason="a")
        assert await s.reresolve(reason="b")
        assert yt.resolves == [True]
        clock.now += 30
        assert await s.reresolve(reason="c")
        assert yt.resolves == [True, True]

    run(go())


def test_a_failed_refresh_keeps_the_session():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)

        async def boom(url: str, force: bool) -> dict[str, Any]:
            raise RuntimeError("rate limited")

        s._resolve = boom
        clock.now += 30
        assert await s.reresolve(reason="x") is True
        assert not s.ended

    run(go())


def test_stalled_playlist_triggers_a_refresh():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        await s.media("95")
        clock.now += 60  # head did not move for > 30 s
        await s.media("95")
        await _drain(s)
        assert yt.resolves == [True]

    run(go())


def test_upcoming_expiry_refreshes_ahead_of_time():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        clock.now = 1_900_000_000 - 600  # ten minutes before expire
        await s.media("95")
        await _drain(s)
        assert yt.resolves == [True]

    run(go())


def test_broadcast_end_closes_the_playlist():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        await s.media("95")
        yt.ended_playlist = True
        clock.now += 10
        body = await s.media("95")
        assert body.rstrip().endswith("#EXT-X-ENDLIST")
        assert s.ended

    run(go())


def test_end_detected_on_refresh_closes_the_playlist():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        await s.media("95")
        yt.live = False
        yt.playlist_status = 404
        clock.now += 30
        body = await s.media("95")
        assert s.ended
        assert body.rstrip().endswith("#EXT-X-ENDLIST")
        assert _sqs(body) == [997, 998, 999, 1000]

    run(go())


def test_last_playlist_is_served_through_a_brief_outage():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        good = await s.media("95")
        yt.playlist_status = 503
        clock.now += 5
        assert await s.media("95") == good
        clock.now += 60
        with pytest.raises(live.LiveUpstreamError):
            await s.media("95")

    run(go())


def test_missing_segment_and_unknown_variant():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        await s.media("95")
        with pytest.raises(LiveSegmentMissing):
            await s.segment("95", 5000)
        with pytest.raises(KeyError):
            await s.media("nope")

    run(go())


def test_manager_shares_sessions_and_evicts_idle_ones():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        manager = LiveSessionManager(dvr_window_sec=0, idle_sec=60, clock=clock)
        a, b = await asyncio.gather(
            manager.open(VID, fetcher=yt.fetch, resolver=yt.resolve),
            manager.open(VID, fetcher=yt.fetch, resolver=yt.resolve),
        )
        assert a is b
        assert yt.resolves == [False]  # one extraction for both viewers
        clock.now += 120
        c = await manager.open(VID, fetcher=yt.fetch, resolver=yt.resolve)
        assert c is not a
        manager.close_all()
        assert manager.sessions() == []

    run(go())


def test_manager_refuses_a_video_that_is_not_live():
    async def go():
        yt = FakeYouTube()
        yt.live = False
        manager = LiveSessionManager(dvr_window_sec=0)
        with pytest.raises(LiveNotAvailable):
            await manager.open(VID, fetcher=yt.fetch, resolver=yt.resolve)
        assert manager.sessions() == []

    run(go())


def test_url_expiry_reads_path_and_query():
    assert live.url_expiry("https://h/x/expire/123/y") == 123
    assert live.url_expiry("https://h/x?expire=456&a=1") == 456
    assert live.url_expiry("https://h/x") is None


def test_media_sequence_never_goes_backwards():
    """The first playlist already carries the DVR window (players map sequence
    numbers to time from it); later probes never lower the start."""

    async def go():
        yt, clock = FakeYouTube(head=1000, window=4, dvr_floor=900), Clock()
        s = _session(yt, clock, dvr_sec=3600)
        first = _sqs(await s.media("95"))
        assert first[0] <= 996  # backfilled already
        starts = [first[0]]
        # YouTube's window grows back (a probe now finds more history).
        yt.dvr_floor = 0
        for _ in range(5):
            clock.now += 31 * 60  # past the reprobe interval
            yt.head += 1
            await s.media("95")
            await _drain(s)
            clock.now += 5
            starts.append(_sqs(await s.media("95"))[0])
        assert starts == sorted(starts)

    run(go())


def test_live_without_hls_formats_on_refresh_does_not_end_the_stream():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        await s.media("95")
        info = yt.info()
        info["formats"] = []

        async def blip(url: str, force: bool) -> dict[str, Any]:
            return info

        s._resolve = blip
        clock.now += 30
        assert await s.reresolve(reason="x") is True
        assert not s.ended

    run(go())


def test_backfilled_segment_gone_raises_the_dvr_floor():
    async def go():
        yt, clock = FakeYouTube(head=1000, window=4, dvr_floor=0), Clock()
        s = _session(yt, clock, dvr_sec=3600)
        await s.media("95")
        assert s.dvr_floor is not None and s.dvr_floor < 500
        yt.dvr_floor = 500  # YouTube dropped older segments
        with pytest.raises(LiveSegmentMissing):
            await s.segment("95", 400)
        assert s.dvr_floor == 401
        clock.now += 10
        assert _sqs(await s.media("95"))[0] == 401

    run(go())


def test_stall_refreshes_back_off():
    async def go():
        yt, clock = FakeYouTube(), Clock()
        s = _session(yt, clock, dvr_sec=0)
        await s.media("95")
        for _ in range(12):  # 6 minutes of a frozen playlist, polled every 30 s
            clock.now += 30
            await s.media("95")
            await _drain(s)
        # 30 s, 60 s, 120 s, 240 s backoff: far fewer than one per poll.
        assert 2 <= len(yt.resolves) <= 4

    run(go())


def test_manager_keeps_active_sessions_over_the_limit():
    async def go():
        clock = Clock()
        manager = LiveSessionManager(dvr_window_sec=0, max_sessions=1, clock=clock)
        yt = FakeYouTube()
        a = await manager.open(VID, fetcher=yt.fetch, resolver=yt.resolve)
        b = await manager.open("bbbbbbbbbbb", fetcher=yt.fetch, resolver=yt.resolve)
        assert {s.video_id for s in manager.sessions()} == {VID, "bbbbbbbbbbb"}
        clock.now += 120  # a went idle (b too, but b is used again now)
        b.touch()
        await manager.open("ccccccccccc", fetcher=yt.fetch, resolver=yt.resolve)
        ids = {s.video_id for s in manager.sessions()}
        assert VID not in ids and "bbbbbbbbbbb" in ids
        assert a is not None

    run(go())


def test_manager_remembers_a_failed_open_briefly():
    async def go():
        clock = Clock()
        manager = LiveSessionManager(dvr_window_sec=0, clock=clock)
        yt = FakeYouTube()
        yt.live = False
        for _ in range(3):
            with pytest.raises(LiveNotAvailable):
                await manager.open(VID, fetcher=yt.fetch, resolver=yt.resolve)
        assert yt.resolves == [False]
        assert manager._opening == {}
        clock.now += 20
        yt.live = True
        assert await manager.open(VID, fetcher=yt.fetch, resolver=yt.resolve)

    run(go())
