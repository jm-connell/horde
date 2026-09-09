"""HTTP regression: download queue without calling yt-dlp."""


def test_presets_and_queue_status(client):
    presets = client.get("/api/downloads/presets")
    assert presets.status_code == 200
    names = presets.json()
    assert "best" in names
    assert "1080p" in names
    assert "audio" in names

    status = client.get("/api/downloads/queue/status")
    assert status.status_code == 200
    body = status.json()
    assert body["paused"] is False
    assert body["active_count"] == 0
    assert body["queued_count"] == 0


def test_enqueue_cancel_and_pause(client, monkeypatch):
    from app.services import downloader, ytdlp_extract

    calls = {"n": 0}

    def fake_preview(url: str, *, priority: int = 0):
        calls["n"] += 1
        raise AssertionError("create must not extract")

    monkeypatch.setattr(ytdlp_extract, "extract_preview", fake_preview)
    monkeypatch.setattr(downloader, "extract_preview", fake_preview)

    created = client.post(
        "/api/downloads",
        json={
            "url": "https://youtu.be/dQw4w9WgXcQ",
            "quality_preset": "720p",
            "title_override": "My Title",
        },
    )
    assert created.status_code == 200
    job = created.json()
    assert job["status"] == "queued"
    assert job["url"] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert job["title"] is None
    assert job["title_override"] == "My Title"
    assert job["quality_preset"] == "720p"
    assert job["thumbnail_url"] == "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
    assert job.get("video_codec") in ("av1", "h264", "h265")
    assert calls["n"] == 0
    job_id = job["id"]

    listed = client.get("/api/downloads").json()
    assert any(row["id"] == job_id for row in listed)

    one = client.get(f"/api/downloads/{job_id}")
    assert one.status_code == 200
    assert one.json()["id"] == job_id

    paused = client.post("/api/downloads/queue/pause")
    assert paused.status_code == 200
    assert paused.json()["paused"] is True

    resumed = client.post("/api/downloads/queue/resume")
    assert resumed.status_code == 200
    assert resumed.json()["paused"] is False

    cancelled = client.post(f"/api/downloads/{job_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"

    assert client.get("/api/downloads/99999").status_code == 404
    assert client.post("/api/downloads/99999/cancel").status_code == 404


def test_enqueue_existing_youtube_is_already_in_library(client, add_video):
    existing = add_video(title="Already have it", yt_id="dQw4w9WgXcQ")
    created = client.post(
        "/api/downloads",
        json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    )
    assert created.status_code == 409
    detail = created.json()["detail"]
    assert detail["code"] == "already_in_library"
    assert detail["message"] == "Already in library"
    listed = client.get("/api/downloads").json()
    assert existing.id not in [row.get("replace_video_id") for row in listed]
    assert [row for row in listed if row.get("status") == "queued"] == []


def test_create_download_requires_url(client):
    resp = client.post("/api/downloads", json={"url": "  "})
    assert resp.status_code == 400


def test_bulk_skips_existing_and_does_not_create_playlist(
    client, add_video
):
    existing = add_video(title="Have it", yt_id="dQw4w9WgXcQ")
    resp = client.post(
        "/api/downloads/bulk",
        json={
            "quality_preset": "720p",
            "urls": [
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "https://www.youtube.com/watch?v=newvideoid1",
                "https://www.youtube.com/playlist?list=PLtest",
            ],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["skipped"] == 2
    assert len(body["jobs"]) == 1
    assert body["jobs"][0]["url"] == "https://www.youtube.com/watch?v=newvideoid1"
    reasons = {skip["reason"] for skip in body["skips"]}
    assert reasons == {"already_in_library", "playlist"}
    assert existing.id not in [
        job.get("replace_video_id") for job in body["jobs"]
    ]
    playlists = client.get("/api/playlists").json()
    assert playlists == []


def test_enqueue_stamps_video_codec(client):
    created = client.post(
        "/api/downloads",
        json={
            "url": "https://youtu.be/dQw4w9WgXcQ",
            "quality_preset": "1080p",
            "video_codec": "h265",
        },
    )
    assert created.status_code == 200
    assert created.json()["video_codec"] == "h265"


def _failed_job(init_db, **fields):
    from sqlmodel import Session

    from app.models import DownloadJob, JobStatus

    values = {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "quality_preset": "720p",
        "status": JobStatus.error,
        "error": "boom",
        "error_kind": "unknown",
        "progress": 40.0,
        "title": "Failed Clip",
    }
    values.update(fields)
    with Session(init_db["engine"]) as session:
        job = DownloadJob(**values)
        session.add(job)
        session.commit()
        session.refresh(job)
        return job.id


def test_retry_failed_job_requeues_once(client, init_db):
    from app.services import downloader

    job_id = _failed_job(init_db)
    downloader.progress_store[job_id] = {
        "status": "error",
        "error": "boom",
        "error_kind": "unknown",
        "progress": 40.0,
    }

    first = client.post(
        f"/api/downloads/{job_id}/retry",
        json={"title_override": "Retried Title"},
    )
    assert first.status_code == 200
    body = first.json()
    assert body["id"] == job_id
    assert body["status"] == "queued"
    assert body["error"] is None
    assert body["error_kind"] is None
    assert body["progress"] == 0.0
    assert body["title_override"] == "Retried Title"
    assert downloader.progress_store[job_id]["status"] == "queued"

    second = client.post(f"/api/downloads/{job_id}/retry", json={})
    assert second.status_code == 200
    assert second.json()["id"] == job_id
    assert second.json()["status"] == "queued"

    listed = client.get("/api/downloads").json()
    assert [row["id"] for row in listed] == [job_id]


def test_retry_cancelled_job(client, init_db):
    from app.models import JobStatus

    job_id = _failed_job(
        init_db,
        status=JobStatus.cancelled,
        error="Cancelled",
        error_kind="cancelled",
    )
    resp = client.post(f"/api/downloads/{job_id}/retry", json={})
    assert resp.status_code == 200
    assert resp.json()["status"] == "queued"


def test_retry_completed_and_missing(client, init_db):
    from app.models import JobStatus

    job_id = _failed_job(init_db, status=JobStatus.completed, error=None, error_kind=None)
    assert client.post(f"/api/downloads/{job_id}/retry", json={}).status_code == 409
    assert client.post("/api/downloads/99999/retry", json={}).status_code == 404


def test_list_jobs_marks_video_missing_after_delete(client, init_db, add_video):
    from sqlmodel import Session

    from app.models import DownloadJob, JobStatus

    video = add_video(title="Keep me", yt_id="dQw4w9WgXcQ", height_px=2160)
    with Session(init_db["engine"]) as session:
        job = DownloadJob(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            quality_preset="720p",
            status=JobStatus.completed,
            title="Keep me",
            video_id=video.id,
        )
        session.add(job)
        session.commit()
        job_id = job.id

    row = next(r for r in client.get("/api/downloads").json() if r["id"] == job_id)
    assert row["video_missing"] is False
    assert row["superseded"] is False
    assert row["height_px"] == 2160

    assert client.delete(f"/api/videos/{video.id}").status_code == 204

    row = next(r for r in client.get("/api/downloads").json() if r["id"] == job_id)
    assert row["video_missing"] is True
    assert row["superseded"] is False
    assert row["url"] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert row["quality_preset"] == "720p"


def test_create_download_reuses_active_job(client):
    payload = {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "quality_preset": "720p",
    }
    first = client.post("/api/downloads", json=payload)
    second = client.post("/api/downloads", json=payload)
    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "already_queued"
    listed = client.get("/api/downloads").json()
    assert len([row for row in listed if row["status"] == "queued"]) == 1


def test_create_download_after_failure_is_new_job(client, init_db):
    failed_id = _failed_job(init_db)
    created = client.post(
        "/api/downloads",
        json={
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "quality_preset": "720p",
        },
    )
    assert created.status_code == 200
    assert created.json()["id"] != failed_id
    listed = client.get("/api/downloads").json()
    assert len(listed) == 2


def test_create_download_keeps_best_until_metadata_fills(client):
    created = client.post(
        "/api/downloads",
        json={
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "quality_preset": "best",
        },
    )
    assert created.status_code == 200
    body = created.json()
    assert body["quality_preset"] == "best"
    assert body["available_presets"] == []


def test_change_quality_on_queued_job(client, monkeypatch):
    from app.services import downloader

    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    monkeypatch.setattr(
        downloader,
        "extract_preview",
        lambda url: {
            "id": "dQw4w9WgXcQ",
            "title": "Preview Title",
            "channel": "Preview Chan",
            "is_playlist": False,
            "available_presets": ["2160p", "1080p", "720p"],
        },
    )
    created = client.post(
        "/api/downloads",
        json={
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "quality_preset": "720p",
        },
    )
    job_id = created.json()["id"]
    changed = client.post(
        f"/api/downloads/{job_id}/quality",
        json={"quality_preset": "1080p"},
    )
    assert changed.status_code == 200
    body = changed.json()
    assert body["id"] == job_id
    assert body["quality_preset"] == "1080p"
    assert body["status"] == "queued"

    same = client.post(
        f"/api/downloads/{job_id}/quality",
        json={"quality_preset": "1080p"},
    )
    assert same.status_code == 200
    assert same.json()["quality_preset"] == "1080p"


def test_change_quality_rejects_finished_and_unknown(client, init_db, monkeypatch):
    from app.models import JobStatus

    job_id = _failed_job(init_db, status=JobStatus.completed, error=None, error_kind=None)
    assert (
        client.post(
            f"/api/downloads/{job_id}/quality", json={"quality_preset": "720p"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/downloads/99999/quality", json={"quality_preset": "720p"}
        ).status_code
        == 404
    )

    from app.services import downloader

    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    monkeypatch.setattr(
        downloader,
        "extract_preview",
        lambda url: {"id": "dQw4w9WgXcQ", "is_playlist": False},
    )
    created = client.post(
        "/api/downloads",
        json={
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "quality_preset": "720p",
        },
    )
    job_id = created.json()["id"]
    bad = client.post(
        f"/api/downloads/{job_id}/quality", json={"quality_preset": "8k"}
    )
    assert bad.status_code == 400


def test_change_quality_restarts_downloading_job(client, init_db, monkeypatch):
    from sqlmodel import Session

    from app.models import DownloadJob, JobStatus
    from app.services import downloader

    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    monkeypatch.setattr(
        downloader,
        "extract_preview",
        lambda url: {
            "id": "dQw4w9WgXcQ",
            "title": "Preview Title",
            "is_playlist": False,
            "available_presets": ["1080p", "720p"],
        },
    )
    created = client.post(
        "/api/downloads",
        json={
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "quality_preset": "1080p",
        },
    )
    job_id = created.json()["id"]
    with Session(init_db["engine"]) as session:
        job = session.get(DownloadJob, job_id)
        job.status = JobStatus.downloading
        job.progress = 40.0
        session.add(job)
        session.commit()

    monkeypatch.setattr(
        downloader.DownloadQueue, "is_running", lambda self, jid: jid == job_id
    )

    def fake_wait(jid, timeout=30.0):
        with Session(init_db["engine"]) as session:
            job = session.get(DownloadJob, jid)
            job.status = JobStatus.queued
            job.progress = 0.0
            session.add(job)
            session.commit()
        return True

    monkeypatch.setattr(downloader, "wait_until_job_not_running", fake_wait)

    changed = client.post(
        f"/api/downloads/{job_id}/quality",
        json={"quality_preset": "720p"},
    )
    assert changed.status_code == 200
    body = changed.json()
    assert body["quality_preset"] == "720p"
    assert body["status"] == "queued"
    assert body["progress"] == 0.0
    assert downloader.progress_store[job_id]["status"] == "queued"


def test_create_download_after_library_delete_is_allowed(client, add_video):
    video = add_video(title="Gone soon", yt_id="dQw4w9WgXcQ")
    assert client.delete(f"/api/videos/{video.id}").status_code == 204
    created = client.post(
        "/api/downloads",
        json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    )
    assert created.status_code == 200
    assert created.json()["status"] == "queued"


def test_list_jobs_keeps_all_queued_when_history_is_long(client, init_db):
    from sqlmodel import Session

    from app.models import DownloadJob, JobStatus

    with Session(init_db["engine"]) as session:
        for i in range(45):
            session.add(
                DownloadJob(
                    url=f"https://www.youtube.com/watch?v=done{i:02d}xxxxxx",
                    quality_preset="720p",
                    status=JobStatus.completed,
                    title=f"Done {i}",
                )
            )
        queued = DownloadJob(
            url="https://www.youtube.com/watch?v=queuedvideoid",
            quality_preset="720p",
            status=JobStatus.queued,
            title="Still queued",
        )
        session.add(queued)
        session.commit()
        queued_id = queued.id

    listed = client.get("/api/downloads").json()
    ids = [row["id"] for row in listed]
    assert queued_id in ids
    queued_row = next(row for row in listed if row["id"] == queued_id)
    assert listed.index(queued_row) == 0


def test_dismiss_finished_includes_cancelled(client, init_db):
    from app.models import JobStatus

    cancelled_id = _failed_job(
        init_db,
        status=JobStatus.cancelled,
        error="Cancelled",
        error_kind="cancelled",
    )
    completed_id = _failed_job(
        init_db,
        url="https://www.youtube.com/watch?v=completedidxx",
        status=JobStatus.completed,
        error=None,
        error_kind=None,
    )
    queued = client.post(
        "/api/downloads",
        json={"url": "https://www.youtube.com/watch?v=stillqueuedxx"},
    ).json()
    resp = client.post("/api/downloads/dismiss-finished")
    assert resp.status_code == 204
    listed = client.get("/api/downloads").json()
    ids = {row["id"] for row in listed}
    assert cancelled_id not in ids
    assert completed_id not in ids
    assert queued["id"] in ids


def test_queue_events_route_registered(client):
    paths = [getattr(route, "path", "") for route in client.app.routes]
    assert "/api/downloads/events" in paths
    assert "/api/downloads/{job_id}/events" in paths

