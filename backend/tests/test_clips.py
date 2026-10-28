"""Clips: part of a stream saved as its own library video (services/downloads/clips.py)."""

from __future__ import annotations

import shutil
import subprocess
import threading
from pathlib import Path

import pytest
from sqlmodel import Session, select
from ytdlp_fakes import FakeYtdlp, make_info, run_job_inline, stub_media_probes

from app.models import DownloadJob, JobStatus, Video
from app.services import url_safety
from app.services.downloads import clips
from app.services.downloads import jobs as download_jobs
from app.services.live import sessions as live_sessions
from app.services.live.hls import VariantInfo
from app.services.youtube_id import derive_youtube_id

YT = "clipstream1"
URL = f"https://www.youtube.com/watch?v={YT}"


@pytest.fixture
def queued(monkeypatch) -> list[int]:
    """Jobs the API queued (the queue itself is not run)."""
    calls: list[int] = []
    monkeypatch.setattr(download_jobs, "enqueue_download", calls.append)
    return calls


def _jobs(session: Session) -> list[DownloadJob]:
    session.expire_all()
    return list(session.exec(select(DownloadJob)).all())


# --- the API ---------------------------------------------------------------------


def test_a_finished_stream_clip_is_queued_with_its_range(client, session, queued):
    resp = client.post(
        "/api/downloads/clips",
        json={"url": URL, "title": "Big stream", "start_sec": 3723, "end_sec": 3900},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["clip_start_sec"], body["clip_end_sec"]) == (3723, 3900)
    assert body["title"] == "Big stream (clip 1:02:03–1:05:00)"
    assert queued == [body["id"]]


def test_clips_are_not_duplicates_of_the_video_or_of_each_other(
    client, session, queued, add_video
):
    add_video(source_url=URL, file_path=f"Chan/2024/Full [{YT}].mp4")
    for start in (10, 10, 500):
        resp = client.post(
            "/api/downloads/clips",
            json={"url": URL, "start_sec": start, "end_sec": start + 30},
        )
        assert resp.status_code == 200, resp.text
    # A queued clip does not make the full video count as queued either.
    assert download_jobs.find_active_job_for_identity(session, URL) is None


@pytest.mark.parametrize(
    "body",
    [
        {"start_sec": 100, "end_sec": 100.5},
        {"start_sec": 200, "end_sec": 100},
        {"start_sec": 0, "end_sec": 7 * 3600},
        {"start_sec": 10},
        {"start_behind_live_sec": 60},
    ],
)
def test_bad_ranges_are_refused(client, queued, body):
    resp = client.post("/api/downloads/clips", json={"url": URL, **body})
    assert (resp.status_code, resp.json()["code"]) == (400, "invalid_clip")
    assert queued == []


def test_only_youtube_videos_can_be_clipped(client, queued):
    resp = client.post(
        "/api/downloads/clips",
        json={"url": "https://example.com/video", "start_sec": 0, "end_sec": 30},
    )
    assert (resp.status_code, resp.json()["code"]) == (400, "invalid_url")


def test_a_live_clip_needs_the_stream_playing(client, queued):
    resp = client.post(
        "/api/downloads/clips",
        json={"url": URL, "start_behind_live_sec": 90, "end_behind_live_sec": 30},
    )
    assert (resp.status_code, resp.json()["code"]) == (409, "live_not_open")


def _live_session(head_sq: int, target: float) -> live_sessions.LiveSession:
    async def unused(*_a, **_k):
        raise AssertionError("not fetched")

    upstream = live_sessions._Upstream(
        url="https://example.invalid/v.m3u8",
        headers={},
        info=VariantInfo(
            key="95", bandwidth=1, width=1280, height=720, fps=None, codecs=None
        ),
    )
    live = live_sessions.LiveSession(
        YT, {"95": upstream}, fetcher=unused, resolver=unused, dvr_window_sec=3600
    )
    variant = live.variants["95"]
    variant.head_sq = head_sq
    variant.target_duration = target
    return live


def test_a_live_clip_is_placed_on_the_broadcast_timeline(app, client, queued):
    # Segment 999 is the newest: the broadcast is 5000 s in and the player's
    # live edge sits three segments (15 s) earlier, at 4985 s.
    manager = app.state.ctx.live.sessions
    manager._sessions[YT] = _live_session(head_sq=999, target=5.0)
    resp = client.post(
        "/api/downloads/clips",
        json={"url": URL, "start_behind_live_sec": 85, "end_behind_live_sec": 25},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["clip_start_sec"], body["clip_end_sec"]) == (4900, 4960)


# --- the clip's identity ---------------------------------------------------------


def test_clip_info_carries_no_youtube_id():
    info = clips.clip_info(make_info(YT, "Stream", live_status="was_live"), 60, 125)
    assert info["title"] == "Stream (clip 1:00–2:05)"
    assert info["duration"] == 65
    assert "webpage_url" not in info and "live_status" not in info
    assert info["description"].startswith(f"Clip 1:00–2:05 of {URL}")
    assert derive_youtube_id(None, f"Chan/2024/x [{info['id']}].mp4") is None


# --- whole jobs --------------------------------------------------------------------


@pytest.fixture
def fake(init_db, monkeypatch):
    f = FakeYtdlp()
    f.install(monkeypatch)
    stub_media_probes(monkeypatch)
    return f


def _add_clip_job(init_db, start: float, end: float) -> int:
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url=URL,
            quality_preset="best",
            status=JobStatus.queued,
            clip_start_sec=start,
            clip_end_sec=end,
        )
        s.add(job)
        s.commit()
        assert job.id is not None
        return job.id


def _videos(init_db) -> list[Video]:
    with Session(init_db["engine"]) as s:
        return list(s.exec(select(Video).order_by(Video.id)).all())


def test_a_finished_stream_clip_becomes_its_own_video(init_db, fake, add_video):
    full = add_video(source_url=URL, file_path=f"Chan/2024/Stream [{YT}].mp4")
    fake.add(URL, make_info(YT, "Stream", live_status="was_live"))
    job_id = _add_clip_job(init_db, 60, 120)
    run_job_inline(job_id)

    videos = _videos(init_db)
    assert [v.id for v in videos][0] == full.id
    (clip,) = [v for v in videos if v.id != full.id]
    assert clip.title == "Stream (clip 1:00–2:00)"
    assert (clip.source_url, clip.youtube_id) == (None, None)
    assert f"[{YT}]" not in clip.file_path
    assert (init_db["downloads"] / clip.file_path).is_file()
    # Only the range was asked of yt-dlp.
    (download,) = fake.downloads
    assert "download_ranges" in download["opts"]


def test_a_live_clip_is_cut_from_the_broadcast(init_db, fake, monkeypatch):
    fake.add(URL, make_info(YT, "Live now", is_live=True, live_status="is_live"))
    cut: list[tuple[float, float]] = []

    def fake_cut(_info, start, end, dest: Path, *, cancel, on_progress):
        cut.append((start, end))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"\x00" * 2048)
        on_progress(100.0)
        return dest

    monkeypatch.setattr(clips, "download_live_clip", fake_cut)
    job_id = _add_clip_job(init_db, 4900, 4960)
    run_job_inline(job_id)

    assert cut == [(4900, 4960)]
    assert fake.downloads == []  # yt-dlp was not asked to record the stream
    (clip,) = _videos(init_db)
    assert clip.title == "Live now (clip 1:21:40–1:22:40)"
    assert clip.youtube_id is None


# --- cutting a live clip from real segments ---------------------------------------


needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg is not installed"
)


def _segments(tmp_path: Path, count: int, seconds: int) -> list[bytes]:
    """``count`` muxed MPEG-TS segments of ``seconds`` each, like a live HLS stream."""
    out = tmp_path / "segments"
    out.mkdir()
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=size=160x90:rate=10:duration={count * seconds}",
            "-f",
            "lavfi",
            "-i",
            f"sine=duration={count * seconds}",
            "-c:v",
            "libx264",
            "-g",
            "10",
            "-c:a",
            "aac",
            "-f",
            "segment",
            "-segment_time",
            str(seconds),
            "-segment_format",
            "mpegts",
            str(out / "seg%d.ts"),
        ],
        check=True,
    )
    return [(out / f"seg{i}.ts").read_bytes() for i in range(count)]


def _duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(result.stdout.strip())


@needs_ffmpeg
def test_download_live_clip_joins_and_trims_the_segments(tmp_path, monkeypatch):
    segs = _segments(tmp_path, count=6, seconds=2)
    playlist_url = "https://manifest.googlevideo.com/hls/index.m3u8"
    seg_url = "https://rr1.googlevideo.com/videoplayback/sq/{n}/file/seg.ts"
    playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n" + "".join(
        f"#EXTINF:2.0,\n{seg_url.format(n=n)}\n" for n in range(6)
    )
    fetched: list[str] = []

    def fake_fetch(url: str, *, max_bytes: int, headers=None, **_k):
        fetched.append(url)
        if url == playlist_url:
            body = playlist.encode()
        else:
            body = segs[int(url.split("/sq/")[1].split("/")[0])]
        return url_safety.FetchResult(body, "application/octet-stream", url)

    monkeypatch.setattr(clips, "fetch_bytes", fake_fetch)
    info = {
        "is_live": True,
        "formats": [
            {
                "format_id": "95",
                "url": playlist_url,
                "protocol": "m3u8_native",
                "vcodec": "avc1.4d401f",
                "acodec": "mp4a.40.2",
                "height": 90,
            }
        ],
    }
    progress: list[float] = []
    dest = tmp_path / "out" / "clip.mp4"
    clips.download_live_clip(
        info, 3.0, 7.0, dest, cancel=threading.Event(), on_progress=progress.append
    )

    # Segments 1..3 cover 2 s - 8 s; the clip is trimmed to 3 s - 7 s.
    assert [u for u in fetched if u != playlist_url] == [
        seg_url.format(n=n) for n in (1, 2, 3)
    ]
    assert _duration(dest) == pytest.approx(4.0, abs=0.6)
    assert progress[-1] == 100.0
    assert sorted(p.name for p in dest.parent.iterdir()) == ["clip.mp4"]


def test_a_clip_from_before_the_dvr_window_fails_clearly(tmp_path, monkeypatch):
    playlist_url = "https://manifest.googlevideo.com/hls/index.m3u8"
    playlist = (
        "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n"
        "https://rr1.googlevideo.com/videoplayback/sq/500/file/seg.ts\n"
    )

    def fake_fetch(url: str, *, max_bytes: int, headers=None, **_k):
        if url == playlist_url:
            return url_safety.FetchResult(playlist.encode(), "text/plain", url)
        raise url_safety.UrlFetchError("Server answered 404")

    monkeypatch.setattr(clips, "fetch_bytes", fake_fetch)
    info = {
        "is_live": True,
        "formats": [
            {
                "format_id": "95",
                "url": playlist_url,
                "protocol": "m3u8_native",
                "vcodec": "avc1.4d401f",
                "acodec": "mp4a.40.2",
                "height": 720,
            }
        ],
    }
    with pytest.raises(clips.ClipUnavailable, match="no longer available"):
        clips.download_live_clip(
            info,
            0.0,
            10.0,
            tmp_path / "clip.mp4",
            cancel=threading.Event(),
            on_progress=lambda _p: None,
        )
