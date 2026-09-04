"""Manual Import-page folder scan: new files and skipped (unimported) videos."""

from pathlib import Path

from sqlmodel import Session

from app.models import Video
from app.services import scanner


def _write_media(path: Path, size: int = 256) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00" * size)


def _stub_ingest(monkeypatch) -> None:
    monkeypatch.setattr(scanner, "probe_is_playable", lambda _p: True)
    monkeypatch.setattr(scanner, "probe_duration", lambda _p: 12.0)
    monkeypatch.setattr(scanner, "probe_dimensions", lambda _p: (1280, 720))
    monkeypatch.setattr(scanner, "probe_frame_rate", lambda _p: 30.0)
    monkeypatch.setattr(scanner, "grab_frame", lambda *_a, **_k: False)
    monkeypatch.setattr(scanner, "_is_stable", lambda _p: True)


def test_scan_ingests_file_not_in_library(client, init_db, monkeypatch):
    _stub_ingest(monkeypatch)
    dest = init_db["downloads"] / "imports" / "dropped.mp4"
    _write_media(dest)

    resp = client.post("/api/review/scan")
    assert resp.status_code == 200
    body = resp.json()
    assert body["added"] == 1
    assert body["requeued"] == 0

    queue = client.get("/api/review").json()
    assert len(queue) == 1
    assert queue[0]["file_path"] == "imports/dropped.mp4"
    assert queue[0]["needs_review"] is True
    assert queue[0]["title"] == "dropped"


def test_scan_requeues_skipped_manual_import(client, add_video, monkeypatch):
    _stub_ingest(monkeypatch)
    skipped = add_video(
        title="Parked",
        channel=None,
        needs_review=False,
        file_path="imports/parked.mp4",
        write_file=True,
    )
    assert skipped.id not in {row["id"] for row in client.get("/api/review").json()}

    resp = client.post("/api/review/scan")
    assert resp.status_code == 200
    body = resp.json()
    assert body["added"] == 0
    assert body["requeued"] == 1

    queue = client.get("/api/review").json()
    assert [row["id"] for row in queue] == [skipped.id]
    assert queue[0]["needs_review"] is True


def test_scan_does_not_requeue_library_video(client, add_video, init_db, monkeypatch):
    _stub_ingest(monkeypatch)
    ready = add_video(
        title="Kept",
        channel="Pets",
        needs_review=False,
        file_path="Pets/Kept.mp4",
        write_file=True,
    )

    resp = client.post("/api/review/scan")
    assert resp.status_code == 200
    assert resp.json() == {"added": 0, "requeued": 0}
    assert client.get("/api/review").json() == []

    with Session(init_db["engine"]) as session:
        row = session.get(Video, ready.id)
        assert row is not None
        assert row.needs_review is False
        assert row.channel == "Pets"


def test_poll_scan_does_not_undo_skip(add_video, init_db, monkeypatch):
    _stub_ingest(monkeypatch)
    skipped = add_video(
        title="Parked",
        channel=None,
        needs_review=False,
        file_path="imports/still-parked.mp4",
        write_file=True,
    )

    added, requeued = scanner.scan_once()
    assert added == 0
    assert requeued == 0

    with Session(init_db["engine"]) as session:
        row = session.get(Video, skipped.id)
        assert row is not None
        assert row.needs_review is False


def test_scan_does_not_requeue_youtube_download_without_channel(
    client, add_video, monkeypatch
):
    _stub_ingest(monkeypatch)
    add_video(
        title="No channel yet",
        channel=None,
        needs_review=False,
        source_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        file_path="Alpha/2024/No channel yet [dQw4w9WgXcQ].mp4",
        write_file=True,
    )

    resp = client.post("/api/review/scan")
    assert resp.status_code == 200
    assert resp.json() == {"added": 0, "requeued": 0}
    assert client.get("/api/review").json() == []


def test_scan_readds_file_after_db_row_deleted(
    client, add_video, init_db, monkeypatch
):
    _stub_ingest(monkeypatch)
    video = add_video(
        title="Removed",
        channel=None,
        needs_review=True,
        file_path="imports/removed.mp4",
        write_file=True,
    )
    deleted = client.delete(f"/api/videos/{video.id}?delete_file=false")
    assert deleted.status_code == 204
    assert (init_db["downloads"] / "imports" / "removed.mp4").exists()
    assert client.get("/api/review").json() == []

    resp = client.post("/api/review/scan")
    assert resp.status_code == 200
    assert resp.json()["added"] == 1
    assert resp.json()["requeued"] == 0
    queue = client.get("/api/review").json()
    assert len(queue) == 1
    assert queue[0]["file_path"] == "imports/removed.mp4"
    assert queue[0]["needs_review"] is True
