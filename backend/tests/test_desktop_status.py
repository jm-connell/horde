"""The desktop status file reports running work and the last media served."""

from __future__ import annotations

from app.services import activity, desktop_status


def test_status_reports_running_work_and_last_media(client, init_db):
    ctx = init_db["ctx"]

    with activity.track("ffmpeg", "Encoding a test clip"):
        status = desktop_status.build_status(ctx)
    assert status["busy"] is True
    assert status["running"] == {"ffmpeg": 1}
    assert status["last_media_at"] is None

    desktop_status.note_media_served()
    assert desktop_status.build_status(ctx)["last_media_at"] is not None
