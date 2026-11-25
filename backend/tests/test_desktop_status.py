"""The desktop status file reports running work and video being served."""

from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app.services import activity, desktop_status


def test_status_reports_running_work(client, init_db):
    ctx = init_db["ctx"]

    with activity.track("ffmpeg", "Encoding a test clip"):
        status = desktop_status.build_status(ctx)
    assert status["busy"] is True
    assert status["running"] == {"ffmpeg": 1}
    assert status["last_media_at"] is None


def test_a_video_being_sent_counts_as_busy_until_it_has_been_sent(client, init_db):
    """One long response (a whole film) must not look idle while it plays."""
    ctx = init_db["ctx"]
    seen: list[dict] = []
    app = FastAPI()

    @app.get("/film", dependencies=[Depends(desktop_status.track_media)])
    def film():
        def body():
            for _ in range(3):
                seen.append(desktop_status.build_status(ctx))
                yield b"x" * 1024

        return StreamingResponse(body())

    assert len(TestClient(app).get("/film").content) == 3 * 1024

    assert [s["media_active"] for s in seen] == [1, 1, 1]
    assert all(s["busy"] for s in seen)
    after = desktop_status.build_status(ctx)
    assert after["media_active"] == 0
    # Other tests in this worker process may leave work running or queued, so
    # assert only that the finished video no longer counts towards busy.
    assert after["busy"] is (bool(after["running"]) or after["queued"] > 0)
    assert after["last_media_at"] is not None
