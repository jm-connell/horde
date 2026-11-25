"""WebM init/index range discovery for the DASH preview manifest."""

from __future__ import annotations

import struct
from types import SimpleNamespace

import pytest

from app.services import stream_preview


def _vint(n: int) -> bytes:
    """Encode an EBML size in the shortest form."""
    for length in range(1, 9):
        if n < (1 << (7 * length)) - 1:
            return (n | (1 << (7 * length))).to_bytes(length, "big")
    raise ValueError(n)


def _el(eid: str, body: bytes) -> bytes:
    return bytes.fromhex(eid) + _vint(len(body)) + body


def _webm(
    *,
    cues_size: int,
    void_before: int = 0,
    duration: float | None = 635.0,
    cues: bool = True,
) -> bytes:
    info_body = _el("2AD7B1", (1_000_000).to_bytes(4, "big"))
    if duration is not None:
        # Duration is a float in TimecodeScale units (here milliseconds).
        info_body += _el("4489", struct.pack(">d", duration * 1000))
    children = _el("114D9B74", b"\x00" * 20)
    children += _el("1549A966", info_body)
    children += _el("1654AE6B", b"\x00" * 30)
    if void_before:
        children += _el("EC", b"\x00" * void_before)
    if cues:
        children += bytes.fromhex("1C53BB6B") + _vint(cues_size) + b"\x00" * cues_size
    children += _el("1F43B675", b"\x00" * 50)
    ebml = _el("1A45DFA3", b"\x00" * 20)
    segment = bytes.fromhex("18538067") + b"\x01" + len(children).to_bytes(7, "big")
    return ebml + segment + children


def test_ranges_end_where_cues_starts():
    data = _webm(cues_size=2189)
    start = data.index(bytes.fromhex("1C53BB6B"))
    init, index, dur = stream_preview._find_webm_ranges(data)
    assert init == f"0-{start - 1}"
    assert index == f"{start}-{start + 4 + 2 + 2189 - 1}"  # id + 2-byte size + body
    assert dur == pytest.approx(635.0)


def test_missing_duration_is_none():
    data = _webm(cues_size=100, duration=None)
    assert stream_preview._find_webm_ranges(data)[2] is None


def test_only_the_cues_header_must_be_in_the_window():
    data = _webm(cues_size=163_814)
    start = data.index(bytes.fromhex("1C53BB6B"))
    assert stream_preview._find_webm_ranges(data[: start + 12])[1].startswith(
        f"{start}-"
    )


def test_a_window_that_stops_before_cues_asks_for_more():
    data = _webm(cues_size=100, void_before=5000)
    assert stream_preview._find_webm_ranges(data[:1000]) is None


def test_no_cues_before_the_first_cluster_fails():
    with pytest.raises(RuntimeError, match="no Cues"):
        stream_preview._find_webm_ranges(_webm(cues_size=0, cues=False))


def test_the_probe_grows_its_window(monkeypatch):
    data = _webm(cues_size=100, void_before=300_000)
    sizes = []

    def fake(url, *, max_bytes, timeout, headers):
        sizes.append(max_bytes)
        return SimpleNamespace(body=data[:max_bytes])

    monkeypatch.setattr(stream_preview, "fetch_bytes", fake)
    init, index, info = stream_preview._probe_webm_ranges("https://x/v", {})
    start = data.index(bytes.fromhex("1C53BB6B"))
    assert sizes == [256 * 1024, 1024 * 1024]
    assert init == f"0-{start - 1}" and info["boundaries"] == []


def test_info_child_overrunning_the_info_body_is_no_duration():
    body = (
        _el("2AD7B1", (1_000_000).to_bytes(4, "big")) + bytes.fromhex("4489") + b"\x88"
    )
    assert stream_preview._webm_info_duration(body + b"\x00" * 3) is None


@pytest.mark.parametrize("value", [0.0, -5.0, float("inf"), float("nan")])
def test_non_positive_or_non_finite_duration_is_none(value):
    body = _el("4489", struct.pack(">d", value))
    assert stream_preview._webm_info_duration(body) is None


# --- VP9 in the manifest -------------------------------------------------------


def _h264(height: int) -> dict:
    return {
        "url": f"https://cdn.example/avc{height}.mp4",
        "format_id": f"avc{height}",
        "ext": "mp4",
        "vcodec": "avc1.640028",
        "acodec": "none",
        "height": height,
        "width": height * 16 // 9,
        "fps": 30,
        "tbr": height,
    }


def _av1(height: int) -> dict:
    return {**_h264(height), "format_id": f"av{height}", "vcodec": "av01.0.08M.08"}


def _vp9(height: int, **extra) -> dict:
    return {
        "url": f"https://cdn.example/vp9-{height}.webm",
        "format_id": f"vp9-{height}",
        "ext": "webm",
        "vcodec": "vp9",
        "acodec": "none",
        "height": height,
        "width": height * 16 // 9,
        "fps": 60 if height == 2160 else 30,
        "tbr": height,
        **extra,
    }


_AUDIO = {
    "url": "https://cdn.example/a.m4a",
    "format_id": "140",
    "ext": "m4a",
    "vcodec": "none",
    "acodec": "mp4a.40.2",
    "abr": 128,
    "language": "en",
}


def _info(*formats: dict) -> dict:
    return {"id": "abc", "formats": [*formats, _AUDIO]}


_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160]


def _families(videos: list[dict]) -> set[str]:
    return {f["_codec_family"] for f in videos}


def test_vp9_above_1080p_joins_the_ladder():
    info = _info(*[_h264(h) for h in _HEIGHTS[:6]], *[_vp9(h) for h in _HEIGHTS])
    videos, _ = stream_preview._pick_adaptive_formats(info)
    assert {f["height"] for f in videos if f["_codec_family"] == "vp09"} == set(
        _HEIGHTS
    )


def test_vp9_at_1080p_or_below_is_left_out():
    info = _info(*[_h264(h) for h in (360, 720)], *[_vp9(h) for h in (360, 720, 1080)])
    videos, _ = stream_preview._pick_adaptive_formats(info)
    assert _families(videos) == {"avc1"}


@pytest.mark.parametrize(
    "extra",
    [
        {"dynamic_range": "HDR10", "vcodec": "vp09.02.51.10"},
        {"vcodec": "vp09.02.51.10"},
        {"dynamic_range": "HDR10"},
    ],
)
def test_hdr_vp9_is_left_out(extra):
    info = _info(_h264(1080), _vp9(1440), _vp9(2160, **extra))
    videos, _ = stream_preview._pick_adaptive_formats(info)
    assert {f["height"] for f in videos if f["_codec_family"] == "vp09"} == {1440}


def test_sdr_vp9_profile_0_is_kept():
    info = _info(_h264(1080), _vp9(2160, dynamic_range="SDR", vcodec="vp09.00.51.08"))
    videos, _ = stream_preview._pick_adaptive_formats(info)
    assert 2160 in {f["height"] for f in videos}


def _patch_probes(monkeypatch, *, webm_raises: bool = False, duration=None):
    def mp4(direct, headers):
        sidx = {
            "timescale": 1000,
            "earliest_presentation_time": 0,
            "duration_sec": 10.0,
            "boundaries": [0.0, 5.0, 10.0],
        }
        return "0-100", "101-200", sidx

    def webm(direct, headers):
        if webm_raises:
            raise RuntimeError("no cues")
        info = {
            "timescale": 0,
            "earliest_presentation_time": 0,
            "duration_sec": duration,
            "boundaries": [],
        }
        return "0-218", "219-2413", info

    monkeypatch.setattr(stream_preview, "_probe_mp4_ranges", mp4)
    monkeypatch.setattr(stream_preview, "_probe_webm_ranges", webm)


def _entry(monkeypatch, *formats, **kw):
    _patch_probes(monkeypatch, **kw)
    return stream_preview._build_manifest_entry("https://youtu.be/abc", _info(*formats))


def test_manifest_lists_webm_between_av1_and_h264(monkeypatch):
    entry = _entry(
        monkeypatch,
        _av1(1080),
        _h264(1080),
        *[_vp9(h) for h in (1080, 1440, 2160)],
    )
    mpd = stream_preview.build_dash_manifest(entry)
    assert (
        mpd.index('codecs="av01')
        < mpd.index('mimeType="video/webm"')
        < mpd.index('codecs="avc1')
    )
    assert 'codecs="vp09.00.51.08"' in mpd  # 3840x2160 at 60 fps
    assert 'indexRange="219-2413"' in mpd
    webm_set = mpd[mpd.index('mimeType="video/webm"') :].split("</AdaptationSet>")[0]
    assert "segmentAlignment" not in webm_set
    assert all(
        r["content_type"] == "video/webm"
        for r in entry["formats"].values()
        if r["codec_family"] == "vp09"
    )


def test_a_single_vp9_rep_does_not_claim_alignment(monkeypatch):
    entry = _entry(monkeypatch, _h264(1080), _vp9(2160))
    mpd = stream_preview.build_dash_manifest(entry)
    webm_set = mpd[mpd.index('mimeType="video/webm"') :].split("</AdaptationSet>")[0]
    assert "segmentAlignment" not in webm_set


def test_a_1080p_video_gets_the_manifest_it_got_before(monkeypatch):
    base = [_av1(1080), _h264(720), _h264(1080)]
    plain = _entry(monkeypatch, *base)
    with_vp9 = _entry(monkeypatch, *base, _vp9(360))
    plain["token"] = with_vp9["token"] = "t"
    assert stream_preview.build_dash_manifest(
        plain
    ) == stream_preview.build_dash_manifest(with_vp9)
    assert "webm" not in stream_preview.build_dash_manifest(with_vp9)


def test_failed_vp9_probes_leave_the_other_ladders(monkeypatch):
    entry = _entry(
        monkeypatch,
        _av1(1080),
        _h264(1080),
        _vp9(1440),
        _vp9(2160),
        webm_raises=True,
    )
    fams = {r["codec_family"] for r in entry["formats"].values()}
    assert fams == {"av01", "avc1", "audio"}


def test_webm_probe_without_a_duration_leaves_the_duration_to_mp4(monkeypatch):
    entry = _entry(monkeypatch, _h264(1080), _vp9(2160), duration=None)
    vp9 = [r for r in entry["formats"].values() if r["codec_family"] == "vp09"]
    assert vp9 and vp9[0]["duration_sec"] is None
    assert entry["duration"] == pytest.approx(10.0)


def test_vp9_codec_string_comes_from_the_resolution_and_rate():
    fmt = _vp9(2160)
    assert stream_preview._codecs_string(fmt, kind="video") == "vp09.00.51.08"
    fmt = _vp9(1440)
    assert stream_preview._codecs_string(fmt, kind="video") == "vp09.00.50.08"
    dotted = _vp9(2160, vcodec="vp09.00.40.08")
    assert stream_preview._codecs_string(dotted, kind="video") == "vp09.00.40.08"
