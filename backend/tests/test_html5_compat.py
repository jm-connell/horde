"""Phone/HTML5 compatibility helpers (no ffmpeg required)."""

from pathlib import Path
import shutil
import subprocess

import pytest

from app.services.html5_compat import (
    MediaProbe,
    ensure_html5_compatible,
    html5_compat_plan,
    is_html5_audio_codec,
    is_html5_video_codec,
    mp4_moov_before_mdat,
    probe_media,
)
from app.services import downloader
from app.services.ytdlp_formats import FORMAT_SORT, QUALITY_FORMATS, format_chain


def _box(tag: bytes, payload: bytes = b"") -> bytes:
    size = 8 + len(payload)
    return size.to_bytes(4, "big") + tag + payload


def test_codec_families():
    assert is_html5_video_codec("h264")
    assert is_html5_video_codec("avc1.640028")
    assert not is_html5_video_codec("av01.0.08M.08")
    assert not is_html5_video_codec("vp9")
    assert is_html5_audio_codec("aac")
    assert is_html5_audio_codec("mp4a.40.2")
    assert not is_html5_audio_codec("opus")


def test_moov_before_mdat(tmp_path: Path):
    front = tmp_path / "front.mp4"
    front.write_bytes(_box(b"ftyp", b"isom") + _box(b"moov") + _box(b"mdat", b"xxxx"))
    assert mp4_moov_before_mdat(front) is True

    tail = tmp_path / "tail.mp4"
    tail.write_bytes(_box(b"ftyp", b"isom") + _box(b"mdat", b"xxxx") + _box(b"moov"))
    assert mp4_moov_before_mdat(tail) is False

    junk = tmp_path / "junk.bin"
    junk.write_bytes(b"not an mp4")
    assert mp4_moov_before_mdat(junk) is None


def test_plan_skips_already_compatible():
    probe = MediaProbe(
        video_codec="h264",
        audio_codec="aac",
        width=1920,
        height=1080,
        format_name="mov,mp4,m4a,3gp,3g2,mj2",
        moov_front=True,
    )
    plan = html5_compat_plan(probe)
    assert not plan.needed


def test_plan_opus_audio_copy_video():
    probe = MediaProbe(
        video_codec="h264",
        audio_codec="opus",
        width=1920,
        height=1080,
        format_name="mov,mp4,m4a,3gp,3g2,mj2",
        moov_front=True,
    )
    plan = html5_compat_plan(probe)
    assert plan.needed
    assert plan.transcode_audio
    assert not plan.transcode_video


def test_plan_av1_1080_transcodes_video():
    probe = MediaProbe(
        video_codec="av1",
        audio_codec="opus",
        width=1920,
        height=1080,
        format_name="mov,mp4,m4a,3gp,3g2,mj2",
        moov_front=False,
    )
    plan = html5_compat_plan(probe)
    assert plan.transcode_video
    assert plan.transcode_audio
    assert plan.faststart


def test_plan_av1_4k_does_not_transcode_video():
    probe = MediaProbe(
        video_codec="av1",
        audio_codec="opus",
        width=3840,
        height=2160,
        format_name="mov,mp4,m4a,3gp,3g2,mj2",
        moov_front=False,
    )
    plan = html5_compat_plan(probe)
    assert not plan.transcode_video
    assert plan.transcode_audio
    assert plan.faststart


def test_plan_webm_remuxes_to_mp4():
    probe = MediaProbe(
        video_codec="h264",
        audio_codec="aac",
        width=1280,
        height=720,
        format_name="matroska,webm",
        moov_front=None,
    )
    plan = html5_compat_plan(probe)
    assert plan.remux_to_mp4
    assert plan.needed


def test_format_chain_prefers_h264_aac():
    best = format_chain("best")
    assert any("avc" in c or "h264" in c for c in best)
    assert any("mp4a" in c or "aac" in c for c in best)
    assert FORMAT_SORT[2].startswith("vcodec:h264")
    assert "acodec:mp4a" in FORMAT_SORT[3]

    capped = format_chain("1080p")
    assert all("height" in c for c in capped)
    assert "best[ext=mp4]/best" not in capped
    assert not any(c == "best" for c in capped)
    assert "avc" in capped[0] or "h264" in capped[0]


def test_quality_formats_best_is_not_unbounded_av1():
    # Primary "best" must ask for H.264+AAC before a raw bv*+ba AV1/Opus merge.
    primary = QUALITY_FORMATS["best"]
    avc_at = primary.find("avc")
    raw_at = primary.find("bv*+ba")
    assert avc_at != -1
    assert raw_at == -1 or avc_at < raw_at


def test_intermediate_compat_sidecar():
    assert downloader._is_intermediate_media("video.compat.12345.mp4")
    assert downloader._is_intermediate_media("video.norm.mp4")
    assert not downloader._is_intermediate_media("video.mp4")


def _yt_fmt(**kwargs):
    fmt = {
        "url": f"https://cdn.example/{kwargs.get('format_id', 'x')}",
        "protocol": "https",
        "ext": "mp4",
        "fps": 30,
        "tbr": 1000,
        "quality": -1,
        "format_note": "",
        "has_drm": False,
    }
    fmt.update(kwargs)
    return fmt


def test_best_selector_picks_h264_aac_not_av1_opus():
    import yt_dlp

    formats = [
        _yt_fmt(
            format_id="401",
            vcodec="av01.0.12M.08",
            acodec="none",
            height=2160,
            width=3840,
            tbr=8000,
            vbr=8000,
        ),
        _yt_fmt(
            format_id="137",
            vcodec="avc1.640028",
            acodec="none",
            height=1080,
            width=1920,
            tbr=2500,
            vbr=2500,
        ),
        _yt_fmt(
            format_id="251",
            vcodec="none",
            acodec="opus",
            ext="webm",
            abr=160,
            tbr=160,
            height=None,
            width=None,
            fps=None,
        ),
        _yt_fmt(
            format_id="140",
            vcodec="none",
            acodec="mp4a.40.2",
            ext="m4a",
            abr=128,
            tbr=128,
            height=None,
            width=None,
            fps=None,
        ),
    ]
    opts = {"format": QUALITY_FORMATS["best"], "format_sort": FORMAT_SORT}
    with yt_dlp.YoutubeDL(opts) as ydl:
        selector = ydl.build_format_selector(QUALITY_FORMATS["best"])
        selected = list(
            selector(
                {
                    "formats": formats,
                    "incomplete": False,
                    "incomplete_formats": False,
                }
            )
        )
    ids = _selected_ids(selected)
    assert "137" in ids
    assert "140" in ids
    assert "401" not in ids
    assert "251" not in ids


def test_2160p_selector_can_still_pick_4k_when_requested():
    import yt_dlp

    formats = [
        _yt_fmt(
            format_id="401",
            vcodec="av01.0.12M.08",
            acodec="none",
            height=2160,
            width=3840,
            tbr=8000,
            vbr=8000,
        ),
        _yt_fmt(
            format_id="137",
            vcodec="avc1.640028",
            acodec="none",
            height=1080,
            width=1920,
            tbr=2500,
            vbr=2500,
        ),
        _yt_fmt(
            format_id="140",
            vcodec="none",
            acodec="mp4a.40.2",
            ext="m4a",
            abr=128,
            tbr=128,
            height=None,
            width=None,
            fps=None,
        ),
    ]
    spec = QUALITY_FORMATS["2160p"]
    with yt_dlp.YoutubeDL({"format": spec, "format_sort": FORMAT_SORT}) as ydl:
        selector = ydl.build_format_selector(spec)
        selected = list(
            selector(
                {
                    "formats": formats,
                    "incomplete": False,
                    "incomplete_formats": False,
                }
            )
        )
    ids = _selected_ids(selected)
    assert "401" in ids
    assert "140" in ids


def _selected_ids(selected) -> set[str]:
    ids: set[str] = set()

    def walk(item):
        if isinstance(item, dict):
            fid = item.get("format_id")
            if fid:
                ids.add(str(fid))
            for key in ("requested_formats", "formats"):
                nested = item.get(key)
                if nested:
                    walk(nested)
        elif isinstance(item, (list, tuple)):
            for child in item:
                walk(child)

    walk(selected)
    return ids


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="ffmpeg/ffprobe required",
)
def test_ensure_html5_compatible_fixes_opus_and_faststart(tmp_path: Path):
    src = tmp_path / "broken.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=0.4:size=160x120:rate=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.4",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "libopus",
            "-shortest",
            str(src),
        ],
        check=True,
        capture_output=True,
        timeout=30,
    )
    before = probe_media(src)
    assert before is not None
    assert is_html5_video_codec(before.video_codec)
    assert not is_html5_audio_codec(before.audio_codec)
    assert before.moov_front is False

    out = ensure_html5_compatible(src)
    after = probe_media(out)
    assert after is not None
    assert is_html5_video_codec(after.video_codec)
    assert is_html5_audio_codec(after.audio_codec)
    assert after.moov_front is True

