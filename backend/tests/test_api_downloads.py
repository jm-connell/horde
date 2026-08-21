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


def test_enqueue_cancel_and_pause(client, monkeypatch, add_video):
    from app.services import downloader

    def fake_preview(url: str):
        return {
            "id": "dQw4w9WgXcQ",
            "title": "Preview Title",
            "channel": "Preview Chan",
            "thumbnail_url": "https://example.com/t.jpg",
            "is_playlist": False,
        }

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
    assert job["title"] == "Preview Title"
    assert job["title_override"] == "My Title"
    assert job["quality_preset"] == "720p"
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


def test_enqueue_sets_replace_video_id_for_existing_youtube(client, monkeypatch, add_video):
    from app.services import downloader

    existing = add_video(title="Already have it", yt_id="dQw4w9WgXcQ")
    monkeypatch.setattr(
        downloader,
        "extract_preview",
        lambda url: {
            "id": "dQw4w9WgXcQ",
            "title": "Again",
            "channel": "Chan",
            "is_playlist": False,
        },
    )
    created = client.post(
        "/api/downloads",
        json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    )
    assert created.status_code == 200
    assert created.json()["replace_video_id"] == existing.id


def test_create_download_requires_url(client):
    resp = client.post("/api/downloads", json={"url": "  "})
    assert resp.status_code == 400


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


def test_create_download_reuses_active_job(client, monkeypatch):
    from app.services import downloader

    monkeypatch.setattr(
        downloader,
        "extract_preview",
        lambda url: {
            "id": "dQw4w9WgXcQ",
            "title": "Preview Title",
            "channel": "Preview Chan",
            "is_playlist": False,
        },
    )
    payload = {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "quality_preset": "720p",
    }
    first = client.post("/api/downloads", json=payload)
    second = client.post("/api/downloads", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    listed = client.get("/api/downloads").json()
    assert len(listed) == 1


def test_create_download_after_failure_is_new_job(client, init_db, monkeypatch):
    from app.services import downloader

    failed_id = _failed_job(init_db)
    monkeypatch.setattr(
        downloader,
        "extract_preview",
        lambda url: {
            "id": "dQw4w9WgXcQ",
            "title": "Preview Title",
            "channel": "Preview Chan",
            "is_playlist": False,
        },
    )
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
