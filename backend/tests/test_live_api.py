"""GET /api/live, the HLS proxy routes and the live flag of /api/preview/meta."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from app.services import follows
from app.services.live.page import LiveBroadcast

VID = "abcdefghijk"
ADMIN_CHAN = "https://youtube.com/@adminchan"
OTHER_CHAN = "https://youtube.com/@otherchan"
MEMBER_CHAN = "https://youtube.com/@memberchan"

MANIFEST = (
    "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/9999999999"
    "/id/x/itag/95/playlist/index.m3u8"
)
SEG = (
    "https://rr1---sn-x.googlevideo.com/videoplayback/id/x.1/itag/95"
    "/source/yt_live_broadcast/expire/9999999999/sq/{n}/file/seg.ts"
)
PLAYLIST_HEAD = 102
PLAYLIST_FIRST = 100


def _broadcast(video_id: str = VID, **over: Any) -> LiveBroadcast:
    fields: dict[str, Any] = {
        "video_id": video_id,
        "title": "Stream",
        "channel_name": None,
        "game": "Celeste",
        "viewers": 42,
        "started_at": datetime(2026, 10, 1, 12, 0, tzinfo=UTC),
    }
    fields.update(over)
    return LiveBroadcast(**fields)


@pytest.fixture
def directory(app):
    return app.state.ctx.live.directory


# --- GET /api/live -------------------------------------------------------------


def test_live_list_only_has_followed_channels(client, session, admin_user, directory):
    follows.follow(session, admin_user.id, ADMIN_CHAN, "Admin Chan")
    directory.record(ADMIN_CHAN, "Admin Chan", _broadcast("aaaaaaaaaaa"))
    directory.record(OTHER_CHAN, "Other", _broadcast("bbbbbbbbbbb"))
    body = client.get("/api/live").json()
    assert body["enabled"] is True
    [item] = body["items"]
    assert item == {
        "channel_url": ADMIN_CHAN,
        "channel_name": "Admin Chan",
        "video_id": "aaaaaaaaaaa",
        "title": "Stream",
        "game": "Celeste",
        "viewers": 42,
        "started_at": "2026-10-01T12:00:00Z",
        "thumbnail_url": "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault_live.jpg",
        "watch_url": "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    }


def test_live_list_skips_channels_that_are_not_live(
    client, session, admin_user, directory
):
    follows.follow(session, admin_user.id, ADMIN_CHAN)
    directory.record(ADMIN_CHAN, "Admin Chan", None)
    assert client.get("/api/live").json()["items"] == []


def test_live_list_dedupes_by_video_id(client, session, admin_user, directory):
    follows.follow(session, admin_user.id, ADMIN_CHAN, "Zed")
    follows.follow(session, admin_user.id, OTHER_CHAN, "Alpha")
    directory.record(ADMIN_CHAN, "Zed", _broadcast())
    directory.record(OTHER_CHAN, "Alpha", _broadcast())
    items = client.get("/api/live").json()["items"]
    assert [i["video_id"] for i in items] == [VID]
    assert items[0]["channel_url"] == OTHER_CHAN  # sorted by name, first wins


def test_live_list_is_per_user(
    client, member_client, session, admin_user, member_user, directory
):
    follows.follow(session, admin_user.id, ADMIN_CHAN)
    follows.follow(session, member_user.id, MEMBER_CHAN)
    directory.record(ADMIN_CHAN, "A", _broadcast("aaaaaaaaaaa"))
    directory.record(MEMBER_CHAN, "M", _broadcast("mmmmmmmmmmm"))
    assert [i["video_id"] for i in client.get("/api/live").json()["items"]] == [
        "aaaaaaaaaaa"
    ]
    assert [i["video_id"] for i in member_client.get("/api/live").json()["items"]] == [
        "mmmmmmmmmmm"
    ]


def test_live_list_ignores_unfollowed_channels(client, session, admin_user, directory):
    follows.follow(session, admin_user.id, ADMIN_CHAN)
    follows.unfollow(session, admin_user.id, ADMIN_CHAN)
    directory.record(ADMIN_CHAN, "A", _broadcast())
    assert client.get("/api/live").json()["items"] == []


def test_live_list_enabled_flag(client, monkeypatch):
    monkeypatch.setattr("app.api.live.LIVE_POLL_SEC", 0)
    body = client.get("/api/live").json()
    assert body["items"] == []
    assert body["enabled"] is False


def test_live_list_requires_sign_in(anon_client):
    assert anon_client.get("/api/live").status_code == 401


# --- GET /api/live/channel ----------------------------------------------------


def test_channel_live_reads_a_fresh_background_check(client, directory, monkeypatch):
    def no_fetch(url):  # pragma: no cover - must not be called
        raise AssertionError("fresh state must not be re-checked")

    monkeypatch.setattr("app.api.live.check_channel", no_fetch)
    directory.record(ADMIN_CHAN, "Admin Chan", _broadcast())
    body = client.get(
        "/api/live/channel", params={"url": "https://www.youtube.com/@AdminChan/videos"}
    ).json()
    assert body["live"]["video_id"] == VID
    assert body["live"]["channel_url"] == ADMIN_CHAN


def test_channel_live_checks_an_unknown_channel_once(client, directory, monkeypatch):
    calls: list[str] = []

    def check(url):
        calls.append(url)
        return _broadcast("ccccccccccc")

    monkeypatch.setattr("app.api.live.check_channel", check)
    for _ in range(2):
        body = client.get("/api/live/channel", params={"url": OTHER_CHAN}).json()
        assert body["live"]["video_id"] == "ccccccccccc"
    assert calls == [OTHER_CHAN]


def test_channel_live_is_null_when_not_live_or_the_check_fails(
    client, directory, monkeypatch
):
    from app.services.url_safety import UrlFetchError

    monkeypatch.setattr("app.api.live.check_channel", lambda url: None)
    assert client.get("/api/live/channel", params={"url": OTHER_CHAN}).json() == {
        "live": None
    }

    def boom(url):
        raise UrlFetchError("HTTP 500")

    monkeypatch.setattr("app.api.live.check_channel", boom)
    body = client.get("/api/live/channel", params={"url": MEMBER_CHAN}).json()
    assert body == {"live": None}


def test_channel_live_rejects_a_non_url(client):
    resp = client.get("/api/live/channel", params={"url": "   "})
    assert resp.status_code == 400
    assert resp.json()["code"] == "invalid_url"


def test_channel_live_requires_sign_in(anon_client):
    assert (
        anon_client.get("/api/live/channel", params={"url": OTHER_CHAN}).status_code
        == 401
    )


# --- HLS proxy -----------------------------------------------------------------


def _info(vid: str = VID, *, live: bool = True) -> dict[str, Any]:
    return {
        "id": vid,
        "title": "t",
        "is_live": live,
        "live_status": "is_live" if live else "not_live",
        "formats": [
            {
                "format_id": "95",
                "protocol": "m3u8_native",
                "url": MANIFEST,
                "vcodec": "avc1.4d401f",
                "acodec": "mp4a.40.2",
                "height": 720,
                "width": 1280,
                "tbr": 2500,
                "fps": 30,
            }
        ],
    }


def _playlist_text() -> str:
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:2",
        f"#EXT-X-MEDIA-SEQUENCE:{PLAYLIST_FIRST}",
    ]
    for n in range(PLAYLIST_FIRST, PLAYLIST_HEAD + 1):
        lines += ["#EXTINF:2.000,", SEG.format(n=n)]
    return "\n".join(lines) + "\n"


class Upstream:
    """Fake googlevideo: records requests; per-URL status overrides."""

    def __init__(self) -> None:
        self.requests: list[str] = []
        self.segment_statuses: list[int] = []  # consumed by real segment fetches
        self.extra_ok_sqs: set[int] = set()  # earlier segments the DVR probe finds

    async def __call__(
        self, url: str, headers: dict[str, str], stream: bool
    ) -> httpx.Response:
        self.requests.append(url)
        request = httpx.Request("GET", url)
        if url == MANIFEST:
            return httpx.Response(
                200, content=_playlist_text().encode(), request=request
            )
        sq = int(url.split("/sq/")[1].split("/")[0])
        if sq > PLAYLIST_HEAD or (sq < PLAYLIST_FIRST and sq not in self.extra_ok_sqs):
            return httpx.Response(404, request=request)
        if self.segment_statuses:
            return httpx.Response(
                self.segment_statuses.pop(0), content=b"x", request=request
            )
        return httpx.Response(200, content=f"TS{sq}".encode(), request=request)


@pytest.fixture
def upstream(monkeypatch, app):
    fake = Upstream()
    monkeypatch.setattr("app.api.live._fetch", fake)
    yield fake
    app.state.ctx.live.sessions.close_all()


@pytest.fixture
def extracted(monkeypatch):
    """yt-dlp stand-in: ``calls`` records (url, force); ``info`` is the answer."""
    state: dict[str, Any] = {"info": _info(), "calls": []}

    def fake(url: str, *, force: bool = False) -> dict[str, Any]:
        state["calls"].append((url, force))
        return state["info"]

    monkeypatch.setattr("app.services.stream_preview._extract_preview_info", fake)
    return state


def _media_lines(text: str) -> list[str]:
    return [ln for ln in text.splitlines() if ln and not ln.startswith("#")]


def test_master_playlist_lists_the_variant(client, upstream, extracted):
    resp = client.get(f"/api/live/{VID}/master.m3u8")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/vnd.apple.mpegurl")
    assert resp.headers["cache-control"] == "no-store"
    lines = resp.text.splitlines()
    assert lines[0] == "#EXTM3U"
    inf = next(ln for ln in lines if ln.startswith("#EXT-X-STREAM-INF:"))
    assert "BANDWIDTH=2500000" in inf
    assert "RESOLUTION=1280x720" in inf
    assert 'CODECS="avc1.4d401f,mp4a.40.2"' in inf
    assert _media_lines(resp.text) == ["v/95.m3u8"]
    assert extracted["calls"] == [(f"https://www.youtube.com/watch?v={VID}", False)]


def test_session_is_reused_between_requests(client, upstream, extracted):
    client.get(f"/api/live/{VID}/master.m3u8")
    client.get(f"/api/live/{VID}/master.m3u8")
    assert len(extracted["calls"]) == 1


def test_media_playlist_rewrites_segments_and_sequence(client, upstream, extracted):
    upstream.extra_ok_sqs = set()  # no DVR beyond the playlist
    resp = client.get(f"/api/live/{VID}/v/95.m3u8")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/vnd.apple.mpegurl")
    assert f"#EXT-X-MEDIA-SEQUENCE:{PLAYLIST_FIRST}" in resp.text
    assert "#EXT-X-TARGETDURATION:2" in resp.text
    assert "#EXT-X-ENDLIST" not in resp.text
    assert _media_lines(resp.text) == [
        f"../seg/95/{n}.ts" for n in range(PLAYLIST_FIRST, PLAYLIST_HEAD + 1)
    ]
    assert "googlevideo" not in resp.text


def test_media_playlist_extends_back_when_the_dvr_probe_finds_segments(
    client, upstream, extracted
):
    upstream.extra_ok_sqs = set(range(PLAYLIST_FIRST))
    resp = client.get(f"/api/live/{VID}/v/95.m3u8")
    assert resp.status_code == 200
    uris = _media_lines(resp.text)
    seqs = [int(u.rsplit("/", 1)[1].removesuffix(".ts")) for u in uris]
    # The probe runs in the background, so the first answer may or may not include
    # the earlier segments; either way it is contiguous and ends at the live edge.
    assert seqs == list(range(seqs[0], PLAYLIST_HEAD + 1))
    assert seqs[0] <= PLAYLIST_FIRST
    first_seq = int(
        next(
            ln
            for ln in resp.text.splitlines()
            if ln.startswith("#EXT-X-MEDIA-SEQUENCE:")
        ).split(":")[1]
    )
    assert first_seq == seqs[0]


def test_segment_streams_the_upstream_body(client, upstream, extracted):
    client.get(f"/api/live/{VID}/v/95.m3u8")
    resp = client.get(f"/api/live/{VID}/seg/95/101.ts")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "video/mp2t"
    assert resp.headers["cache-control"] == "private, max-age=3600"
    assert resp.content == b"TS101"
    assert SEG.format(n=101) in upstream.requests


def test_segment_without_a_playlist_uses_nothing_unknown(client, upstream, extracted):
    # No playlist fetched yet: the session has no template, so nothing is addressable.
    resp = client.get(f"/api/live/{VID}/seg/95/101.ts")
    assert resp.status_code == 404
    assert resp.json()["code"] == "segment_gone"


def test_segment_403_re_extracts_once_and_retries(client, app, upstream, extracted):
    client.get(f"/api/live/{VID}/v/95.m3u8")
    [live_session] = app.state.ctx.live.sessions.sessions()
    live_session._resolved_at -= 3600  # the 8 s re-extraction debounce has passed
    upstream.segment_statuses = [403]
    resp = client.get(f"/api/live/{VID}/seg/95/101.ts")
    assert resp.status_code == 200
    assert resp.content == b"TS101"
    assert extracted["calls"] == [
        (f"https://www.youtube.com/watch?v={VID}", False),
        (f"https://www.youtube.com/watch?v={VID}", True),
    ]


def test_segment_persistent_403_gives_up_after_one_retry(
    client, app, upstream, extracted
):
    client.get(f"/api/live/{VID}/v/95.m3u8")
    [live_session] = app.state.ctx.live.sessions.sessions()
    live_session._resolved_at -= 3600
    upstream.segment_statuses = [403, 403, 403]
    resp = client.get(f"/api/live/{VID}/seg/95/101.ts")
    assert resp.status_code == 502
    assert resp.json()["code"] == "live_upstream"
    assert sum(1 for c in extracted["calls"] if c[1]) == 1


def test_segment_404_is_gone(client, upstream, extracted):
    client.get(f"/api/live/{VID}/v/95.m3u8")
    resp = client.get(f"/api/live/{VID}/seg/95/{PLAYLIST_HEAD + 50}.ts")
    assert resp.status_code == 404
    assert resp.json()["code"] == "segment_gone"


def test_segment_unknown_variant_is_404(client, upstream, extracted):
    resp = client.get(f"/api/live/{VID}/seg/nope/101.ts")
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_found"


def test_not_live_master_is_409(client, upstream, extracted):
    extracted["info"] = _info(live=False)
    resp = client.get(f"/api/live/{VID}/master.m3u8")
    assert resp.status_code == 409
    assert resp.json()["code"] == "not_live"


def test_live_without_muxed_hls_formats_is_409(client, upstream, extracted):
    extracted["info"]["formats"][0]["acodec"] = "none"
    resp = client.get(f"/api/live/{VID}/master.m3u8")
    assert resp.status_code == 409
    assert resp.json()["code"] == "not_live"


def _split_info() -> dict[str, Any]:
    """How YouTube serves many broadcasts now: video-only TS + audio-only AAC."""
    info = _info()
    base = {"protocol": "m3u8_native", "url": MANIFEST}
    info["formats"] = [
        {**base, "format_id": "233", "vcodec": "none", "acodec": None},
        {**base, "format_id": "234", "vcodec": "none", "acodec": None},
        {
            **base,
            "format_id": "232",
            "vcodec": "avc1.4D401F",
            "acodec": "none",
            "height": 720,
            "width": 1280,
            "tbr": 2448,
        },
    ]
    return info


def test_split_audio_and_video_streams_play(client, upstream, extracted):
    extracted["info"] = _split_info()
    master = client.get(f"/api/live/{VID}/master.m3u8")
    assert master.status_code == 200
    assert (
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,'
        'AUTOSELECT=YES,URI="v/234.m3u8"' in master.text
    )
    inf = next(ln for ln in master.text.splitlines() if ln.startswith("#EXT-X-STREAM"))
    assert 'CODECS="avc1.4D401F,mp4a.40.2"' in inf
    assert 'AUDIO="audio"' in inf
    assert _media_lines(master.text) == ["v/232.m3u8"]

    audio = client.get(f"/api/live/{VID}/v/234.m3u8")
    assert audio.status_code == 200
    assert _media_lines(audio.text)[-1] == f"../seg/234/{PLAYLIST_HEAD}.aac"
    video = client.get(f"/api/live/{VID}/v/232.m3u8")
    assert _media_lines(video.text)[-1] == f"../seg/232/{PLAYLIST_HEAD}.ts"

    seg = client.get(f"/api/live/{VID}/seg/234/101.aac")
    assert seg.status_code == 200
    assert seg.headers["content-type"] == "audio/aac"
    assert seg.content == b"TS101"


def test_extraction_failure_is_502(client, upstream, monkeypatch):
    def boom(url: str, *, force: bool = False):
        raise RuntimeError("yt-dlp exploded")

    monkeypatch.setattr("app.services.stream_preview._extract_preview_info", boom)
    resp = client.get(f"/api/live/{VID}/master.m3u8")
    assert resp.status_code == 502
    assert resp.json()["code"] == "live_upstream"


def test_unknown_variant_playlist_is_404(client, upstream, extracted):
    resp = client.get(f"/api/live/{VID}/v/nope.m3u8")
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_found"


def test_upstream_playlist_error_is_502(client, upstream, extracted, monkeypatch):
    async def failing(url: str, headers: dict[str, str], stream: bool):
        return httpx.Response(500, request=httpx.Request("GET", url))

    monkeypatch.setattr("app.api.live._fetch", failing)
    resp = client.get(f"/api/live/{VID}/v/95.m3u8")
    assert resp.status_code == 502
    assert resp.json()["code"] == "live_upstream"


@pytest.mark.parametrize(
    "path",
    [
        "/api/live/short/master.m3u8",
        "/api/live/{vid}!!/master.m3u8",
        "/api/live/{vid}/v/bad key.m3u8",
        "/api/live/{vid}/seg/95/-1.ts",
        "/api/live/{vid}/seg/95/abc.ts",
    ],
)
def test_invalid_path_parameters_are_rejected(client, upstream, extracted, path):
    resp = client.get(path.format(vid=VID))
    assert resp.status_code in (404, 422)
    assert extracted["calls"] == []


def test_hls_routes_require_sign_in(anon_client):
    assert anon_client.get(f"/api/live/{VID}/master.m3u8").status_code == 401
    assert anon_client.get(f"/api/live/{VID}/v/95.m3u8").status_code == 401
    assert anon_client.get(f"/api/live/{VID}/seg/95/1.ts").status_code == 401


# --- /api/preview/meta ---------------------------------------------------------


@pytest.mark.parametrize("live", [True, False])
def test_preview_meta_reports_is_live(client, monkeypatch, live):
    meta = {
        "id": VID,
        "title": "Some stream",
        "channel": "Chan",
        "is_live": live,
        "was_live": not live,
        "available_presets": [],
        "subtitles": [],
    }
    monkeypatch.setattr(
        "app.services.stream_preview.extract_stream_preview_meta", lambda url: meta
    )
    resp = client.get(
        "/api/preview/meta", params={"url": f"https://www.youtube.com/watch?v={VID}"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_live"] is live
    assert resp.json()["was_live"] is (not live)


def test_preview_meta_is_live_defaults_to_false(client, monkeypatch):
    monkeypatch.setattr(
        "app.services.stream_preview.extract_stream_preview_meta",
        lambda url: {"id": VID, "title": "x"},
    )
    resp = client.get(
        "/api/preview/meta", params={"url": f"https://www.youtube.com/watch?v={VID}"}
    )
    assert resp.status_code == 200
    assert resp.json()["is_live"] is False
    assert resp.json()["was_live"] is False
