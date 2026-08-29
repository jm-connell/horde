"""Download progress hook math (no yt-dlp)."""

import threading

from app.services import downloader


def test_chunked_progress_uses_filesize_not_range_total():
    tracker = downloader._DownloadProgress()
    snap = tracker.apply(
        {
            "status": "downloading",
            "downloaded_bytes": 23_000_000,
            "total_bytes": 10_000_000,
            "info_dict": {"filesize": 345_000_000, "title": "Clip"},
        }
    )
    assert snap is not None
    assert snap["status"] == "downloading"
    assert snap["total_bytes"] == 345_000_000
    assert snap["downloaded_bytes"] == 23_000_000
    assert 6 <= snap["progress"] <= 7
    assert snap["title"] == "Clip"


def test_intermediate_finished_stays_downloading():
    tracker = downloader._DownloadProgress()
    info = {"filesize": 345_000_000, "title": "Clip"}
    tracker.apply(
        {
            "status": "downloading",
            "downloaded_bytes": 10_000_000,
            "total_bytes": 10_000_000,
            "info_dict": info,
        }
    )
    snap = tracker.apply(
        {
            "status": "finished",
            "downloaded_bytes": 10_000_000,
            "total_bytes": 10_000_000,
            "filename": "/tmp/Clip.f401.mp4",
            "info_dict": info,
        }
    )
    assert snap is not None
    assert snap["status"] == "downloading"
    assert snap["progress"] < 10
    assert snap["total_bytes"] == 345_000_000


def test_video_then_audio_combines_totals():
    tracker = downloader._DownloadProgress()
    video = {"filesize": 300_000_000, "title": "Clip"}
    audio = {"filesize": 20_000_000, "title": "Clip"}
    tracker.apply(
        {
            "status": "downloading",
            "downloaded_bytes": 300_000_000,
            "total_bytes": 300_000_000,
            "info_dict": video,
        }
    )
    tracker.apply(
        {
            "status": "finished",
            "downloaded_bytes": 300_000_000,
            "total_bytes": 300_000_000,
            "filename": "/tmp/Clip.f401.mp4",
            "info_dict": video,
        }
    )
    snap = tracker.apply(
        {
            "status": "downloading",
            "downloaded_bytes": 5_000_000,
            "total_bytes": 20_000_000,
            "info_dict": audio,
        }
    )
    assert snap is not None
    assert snap["status"] == "downloading"
    assert snap["downloaded_bytes"] == 305_000_000
    assert snap["total_bytes"] == 320_000_000
    assert 95 <= snap["progress"] < 100


def test_percent_drops_when_known_total_grows():
    tracker = downloader._DownloadProgress()
    first = tracker.apply(
        {
            "status": "downloading",
            "downloaded_bytes": 50_000_000,
            "total_bytes": 50_000_000,
            "info_dict": {"filesize": 50_000_000},
        }
    )
    assert first is not None
    assert first["progress"] == 100.0
    second = tracker.apply(
        {
            "status": "downloading",
            "downloaded_bytes": 50_000_000,
            "total_bytes": 50_000_000,
            "info_dict": {"filesize": 200_000_000},
        }
    )
    assert second is not None
    assert second["progress"] == 25.0
    assert second["total_bytes"] == 200_000_000


def test_final_finished_is_processing():
    tracker = downloader._DownloadProgress()
    info = {"filesize": 345_000_000, "title": "Clip"}
    tracker.apply(
        {
            "status": "downloading",
            "downloaded_bytes": 345_000_000,
            "total_bytes": 345_000_000,
            "info_dict": info,
        }
    )
    snap = tracker.apply(
        {
            "status": "finished",
            "downloaded_bytes": 345_000_000,
            "total_bytes": 345_000_000,
            "filename": "/tmp/Clip.mp4",
            "info_dict": info,
        }
    )
    assert snap is not None
    assert snap["status"] == "processing"
    assert snap["progress"] >= 99


def test_progress_hook_writes_store():
    job_id = 9_000_042
    downloader.progress_store.pop(job_id, None)
    hook = downloader._make_progress_hook(job_id, threading.Event())
    hook(
        {
            "status": "downloading",
            "downloaded_bytes": 23_000_000,
            "total_bytes": 10_000_000,
            "info_dict": {"filesize": 345_000_000, "title": "Clip"},
        }
    )
    snap = downloader.progress_store.pop(job_id)
    assert snap["progress"] < 10
    assert snap["total_bytes"] == 345_000_000
    assert snap["downloaded_bytes"] == 23_000_000
