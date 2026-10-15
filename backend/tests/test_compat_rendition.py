"""H.264 sidecar renditions: ffmpeg command, queue, API, file lifecycle."""

from pathlib import Path

import pytest

from app.services import compat_rendition
from app.services.compat_rendition import compat_dimensions, compat_ffmpeg_cmd
from app.services.encode_probe import EncoderChoice
from app.services.paths import compat_sidecar_path

NVENC = EncoderChoice(name="h264_nvenc", kind="nvenc", hw=True)
X264 = EncoderChoice(name="libx264", kind="software", hw=False)
VAAPI = EncoderChoice(name="h264_vaapi", kind="vaapi", hw=True)


@pytest.fixture(autouse=True)
def _no_workers(monkeypatch):
    monkeypatch.setattr(compat_rendition, "_dispatch", lambda: None)
    compat_rendition._jobs.clear()
    compat_rendition._pending.clear()
    compat_rendition._errors.clear()
    yield
    compat_rendition._jobs.clear()
    compat_rendition._pending.clear()


def test_sidecar_path_and_scanner_ignores_it(tmp_path):
    from app.services.scanner import _is_media

    original = tmp_path / "Chan" / "Title [abcdefghijk].mp4"
    side = compat_sidecar_path(original)
    assert side.name == "Title [abcdefghijk].horde-h264.mp4"
    side.parent.mkdir(parents=True)
    side.write_bytes(b"x")
    original.write_bytes(b"x")
    assert _is_media(original)
    assert not _is_media(side)
    tmp = side.with_name("Title [abcdefghijk].horde-h264.dl.mp4")
    tmp.write_bytes(b"x")
    assert not _is_media(tmp)


def test_compat_dimensions():
    assert compat_dimensions(3840, 2160) == (1920, 1080)
    assert compat_dimensions(1920, 1080) is None
    assert compat_dimensions(1280, 720) is None
    # Vertical 4K keeps a 1080 short side.
    assert compat_dimensions(2160, 3840) == (1080, 1920)
    assert compat_dimensions(1279, 719) == (1278, 718)
    assert compat_dimensions(None, 1080) is None


def _cmd(encoder, **kw):
    args = dict(
        src_vcodec="av1",
        bit_depth=8,
        width=3840,
        height=2160,
        fps=30.0,
        is_hdr=False,
        copy_audio=False,
    )
    args.update(kw)
    return compat_ffmpeg_cmd(Path("in.mp4"), Path("out.mp4"), encoder, **args)


def test_nvenc_av1_source_decodes_on_cpu():
    cmd = _cmd(NVENC)
    assert "-hwaccel" not in cmd  # Turing NVDEC has no AV1
    assert "h264_nvenc" in cmd
    vf = cmd[cmd.index("-vf") + 1]
    assert "scale=1920:1080" in vf and vf.endswith("format=yuv420p")
    assert cmd[cmd.index("-c:a") + 1] == "aac"
    assert cmd[-3:-1] == ["mp4", "out.mp4"] or cmd[-1] == "out.mp4"
    assert "+faststart" in cmd


def test_nvenc_vp9_source_uses_nvdec_but_not_without_hw_decode():
    assert "-hwaccel" in _cmd(NVENC, src_vcodec="vp9")
    assert "-hwaccel" not in _cmd(NVENC, src_vcodec="vp9", hw_decode=False)
    # 10-bit H.264 is not decodable by NVDEC.
    assert "-hwaccel" not in _cmd(NVENC, src_vcodec="h264", bit_depth=10)


def test_hdr_tonemaps_only_when_filters_exist():
    with_filters = _cmd(X264, is_hdr=True, filters=frozenset({"zscale", "tonemap"}))
    assert "tonemap=tonemap=hable" in with_filters[with_filters.index("-vf") + 1]
    without = _cmd(X264, is_hdr=True)
    assert "tonemap" not in without[without.index("-vf") + 1]


def test_vaapi_uploads_frames_and_copy_audio():
    cmd = _cmd(VAAPI, copy_audio=True)
    assert "-init_hw_device" in cmd
    assert cmd[cmd.index("-vf") + 1].endswith("format=nv12,hwupload")
    assert cmd[cmd.index("-c:a") + 1] == "copy"


def test_software_x264_args():
    cmd = _cmd(X264, width=1920, height=1080)
    assert "libx264" in cmd and "veryfast" in cmd
    assert "scale=" not in cmd[cmd.index("-vf") + 1]


def test_enqueue_idempotent_and_front(add_video):
    a = add_video(vcodec="av1")
    b = add_video(vcodec="av1")
    assert compat_rendition.enqueue(a.id, reason="bulk") == "queued"
    assert compat_rendition.enqueue(b.id, reason="bulk") == "queued"
    assert compat_rendition.enqueue(a.id) == "already_queued"
    assert list(compat_rendition._pending) == [a.id, b.id]
    compat_rendition.enqueue(b.id, front=True)
    assert list(compat_rendition._pending) == [b.id, a.id]
    assert compat_rendition.cancel(a.id)
    assert list(compat_rendition._pending) == [b.id]
    assert compat_rendition.cancel_all() == 1
    assert not compat_rendition._pending


def test_stream_compat_rendition(client, add_video, init_db):
    video = add_video(write_file=True, vcodec="av1", width_px=1920, height_px=1080)
    resp = client.get(f"/api/videos/{video.id}/stream?rendition=compat")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "compat_unavailable"

    original = init_db["downloads"] / video.file_path
    side = compat_sidecar_path(original)
    side.write_bytes(b"h264-bytes")
    from sqlmodel import Session

    from app.database import engine
    from app.models import Video

    with Session(engine) as s:
        row = s.get(Video, video.id)
        row.compat_path = side.relative_to(init_db["downloads"]).as_posix()
        row.compat_size = 10
        s.add(row)
        s.commit()

    resp = client.get(f"/api/videos/{video.id}/stream?rendition=compat")
    assert resp.status_code == 200
    assert resp.content == b"h264-bytes"
    ranged = client.get(
        f"/api/videos/{video.id}/stream?rendition=compat",
        headers={"Range": "bytes=0-3"},
    )
    assert ranged.status_code == 206 and ranged.content == b"h264"
    assert (
        client.get(f"/api/videos/{video.id}/stream?rendition=bogus").status_code == 400
    )

    body = client.get(f"/api/videos/{video.id}").json()
    assert body["has_compat"] is True
    assert body["compat"]["status"] == "ready"
    assert body["vcodec"] == "av1"

    stats = client.get("/api/stats/storage").json()
    assert stats["compat_bytes"] == 10

    client.delete(f"/api/videos/{video.id}?delete_file=true")
    assert not original.exists()
    assert not side.exists()


def test_request_compat_queues_and_rejects_h264(client, add_video):
    from app.models import utcnow

    av1 = add_video(
        vcodec="av1", media_probed_at=utcnow(), width_px=1920, height_px=1080
    )
    resp = client.post(f"/api/videos/{av1.id}/compat")
    assert resp.status_code == 200
    assert resp.json()["status"] == "queued"
    assert client.get(f"/api/videos/{av1.id}/compat").json()["status"] == "queued"

    h264 = add_video(
        vcodec="h264",
        bit_depth=8,
        media_probed_at=utcnow(),
        width_px=1920,
        height_px=1080,
    )
    assert client.post(f"/api/videos/{h264.id}/compat").status_code == 409


def test_summary_backfill_and_convert(client, add_video):
    from app.models import utcnow

    now = utcnow()
    add_video(
        vcodec="av1",
        media_probed_at=now,
        width_px=1920,
        height_px=1080,
        duration_sec=600,
    )
    add_video(
        vcodec="vp9",
        media_probed_at=now,
        width_px=3840,
        height_px=2160,
        duration_sec=60,
    )
    add_video(
        vcodec="h264", bit_depth=8, media_probed_at=now, width_px=1920, height_px=1080
    )
    add_video(vcodec=None, media_probed_at=now)  # audio-only

    summary = client.get("/api/compat/summary").json()
    assert summary["videos"] == 4
    assert summary["compat_missing"] == 2
    assert summary["convertible"] == 2
    # ~5.16 Mbps × 660 s ≈ 425 MB
    assert 350_000_000 < summary["compat_missing_est_bytes"] < 500_000_000

    assert client.post("/api/compat/backfill").json() == {
        "queued": 2,
        "already_queued": 0,
    }
    assert client.post("/api/compat/backfill").json() == {
        "queued": 0,
        "already_queued": 2,
    }
    assert client.get("/api/compat/summary").json()["queued"] == 2

    assert client.post("/api/compat/convert-library", json={}).status_code == 400
    # Already-queued compat jobs keep their slot; convert is per video.
    resp = client.post("/api/compat/convert-library", json={"confirm": True})
    assert resp.status_code == 200
    assert client.post("/api/compat/cancel", json={}).json()["cancelled"] == 2


def test_rename_moves_sidecar(session, add_video, init_db):
    from app.services.paths import rename_video_file

    video = add_video(write_file=True, file_path="_imports/old.mp4")
    original = init_db["downloads"] / video.file_path
    side = compat_sidecar_path(original)
    side.write_bytes(b"s")
    video.compat_path = side.relative_to(init_db["downloads"]).as_posix()
    rename_video_file(session, video, "_imports/new.mp4")
    session.commit()
    assert video.compat_path == "_imports/new.horde-h264.mp4"
    assert (init_db["downloads"] / video.compat_path).exists()
    assert not side.exists()


@pytest.mark.skipif(__import__("shutil").which("ffmpeg") is None, reason="needs ffmpeg")
def test_worker_encodes_sidecar_end_to_end(add_video, init_db, monkeypatch):
    import subprocess

    from sqlmodel import Session

    from app.database import engine
    from app.models import Video

    video = add_video(write_file=True, width_px=640, height_px=360, duration_sec=1.0)
    src = init_db["downloads"] / video.file_path
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440",
            "-t",
            "1",
            "-c:v",
            "mpeg4",
            "-c:a",
            "libopus",
            "-shortest",
            str(src),
        ],
        check=True,
    )
    # Force the software path so the test is deterministic on any host.
    monkeypatch.setattr(
        compat_rendition,
        "pick_encoder",
        lambda target, encoders: X264 if "libx264" in encoders else None,
    )
    if (
        compat_rendition.pick_encoder(
            "h264", compat_rendition.probe_encode_capabilities().encoders
        )
        is None
    ):
        pytest.skip("ffmpeg lacks libx264")

    job = compat_rendition._Job(
        video_id=video.id, kind="compat", prefer_download=False, reason="test"
    )
    compat_rendition._jobs[video.id] = job
    compat_rendition._worker(job)

    with Session(engine) as s:
        row = s.get(Video, video.id)
        assert row.compat_error is None
        assert row.compat_source == "transcode"
        assert row.vcodec == "mpeg4"
        side = init_db["downloads"] / row.compat_path
        assert side == compat_sidecar_path(src)
        assert row.compat_size == side.stat().st_size > 0

    from app.services.media_info import probe_stream_info

    out = probe_stream_info(side)
    assert out.vcodec == "h264" and out.acodec == "aac" and out.bit_depth == 8
    assert video.id not in compat_rendition._jobs


def test_full_resolution_copy_caps_at_4k():
    assert compat_dimensions(3840, 2160, 2160) is None
    assert compat_dimensions(7680, 4320, 2160) == (3840, 2160)
    assert compat_dimensions(2560, 1440, 2160) is None
    cmd = _cmd(NVENC, cap=2160)
    vf = cmd[cmd.index("-vf") + 1]
    assert "scale=" not in vf
    assert cmd[cmd.index("-maxrate") + 1] == "40M"
    assert _cmd(NVENC)[_cmd(NVENC).index("-maxrate") + 1] == "12M"


def test_needs_compat_respects_cap():
    from app.models import Video, utcnow
    from app.services.media_info import needs_compat

    uhd_h264 = Video(
        title="t",
        file_path="x.mp4",
        media_probed_at=utcnow(),
        vcodec="h264",
        bit_depth=8,
        width_px=3840,
        height_px=2160,
    )
    assert needs_compat(uhd_h264, 1080)
    assert not needs_compat(uhd_h264, 2160)


def test_copy_cap_setting(init_db):
    from app.services import app_settings
    from app.services.ytdlp_formats import compat_copy_cap, normalize_compat_resolution

    assert compat_copy_cap() == 1080
    app_settings.save({"ui": {"compat_copy_resolution": "source"}})
    assert compat_copy_cap() == 2160
    assert normalize_compat_resolution("bogus") == "1080p"


@pytest.mark.parametrize(
    "cap_setting,width,height,expect_download",
    [
        ("1080p", 3840, 2160, True),  # YouTube's 1080p H.264 is enough
        ("source", 1920, 1080, True),  # source is ≤1080p: native matches
        ("source", 3840, 2160, False),  # needs a 4K encode
    ],
)
def test_native_download_only_when_it_meets_the_cap(
    add_video, init_db, monkeypatch, cap_setting, width, height, expect_download
):
    from app.models import utcnow
    from app.services import app_settings

    app_settings.save({"ui": {"compat_copy_resolution": cap_setting}})
    video = add_video(
        write_file=True,
        vcodec="av1",
        media_probed_at=utcnow(),
        width_px=width,
        height_px=height,
        source_url="https://www.youtube.com/watch?v=aaaaaaaaa01",
        platform="Youtube",
    )
    calls = {"download": 0, "encode": None}

    def fake_download(src, dest, cancel, progress):
        calls["download"] += 1
        return None  # pretend YouTube had no avc1 → falls back to encode

    def fake_encode(src, dest, job, progress, handle, **kw):
        calls["encode"] = kw["cap"]
        dest.write_bytes(b"x")
        return dest

    monkeypatch.setattr(compat_rendition, "_download_native_h264", fake_download)
    monkeypatch.setattr(compat_rendition, "_encode_compat", fake_encode)
    monkeypatch.setattr(compat_rendition, "ensure_safari_mp4", lambda p, **k: p)
    job = compat_rendition._Job(
        video_id=video.id, kind="compat", prefer_download=True, reason="t"
    )
    compat_rendition._jobs[video.id] = job
    compat_rendition._worker(job)
    assert calls["download"] == (1 if expect_download else 0)
    assert calls["encode"] == (2160 if cap_setting == "source" else 1080)
