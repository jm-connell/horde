"""Watch history is per user; everything else about the library is shared."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlmodel import select

from app.models import UserVideoState


def _progress(c, video_id, seconds):
    resp = c.patch(f"/api/videos/{video_id}/progress", json={"position_sec": seconds})
    assert resp.status_code == 204


def _row(c, video_id):
    return next(r for r in c.get("/api/videos").json()["items"] if r["id"] == video_id)


def test_progress_is_private_to_each_user(client, member_client, add_video):
    video = add_video(title="Shared", duration_sec=200.0)
    _progress(client, video.id, 60)

    assert client.get(f"/api/videos/{video.id}").json()["last_position_sec"] == 60.0
    mine = member_client.get(f"/api/videos/{video.id}").json()
    assert mine["last_position_sec"] == 0.0
    assert mine["last_watched_at"] is None

    _progress(member_client, video.id, 120)
    assert client.get(f"/api/videos/{video.id}").json()["last_position_sec"] == 60.0
    assert (
        member_client.get(f"/api/videos/{video.id}").json()["last_position_sec"]
        == 120.0
    )
    assert _row(client, video.id)["last_position_sec"] == 60.0
    assert _row(member_client, video.id)["last_position_sec"] == 120.0


def test_continue_watching_and_history_are_per_user(client, member_client, add_video):
    first = add_video(title="First", duration_sec=200.0)
    second = add_video(title="Second", duration_sec=200.0)
    _progress(client, first.id, 60)
    _progress(member_client, second.id, 90)

    def ids(c, **params):
        return [r["id"] for r in c.get("/api/videos", params=params).json()["items"]]

    assert ids(client, continue_watching=True) == [first.id]
    assert ids(member_client, continue_watching=True) == [second.id]
    assert ids(client, watched_only=True) == [first.id]
    assert ids(member_client, watched_only=True) == [second.id]
    assert ids(client, sort="last_watched_at", order="desc")[0] == first.id
    assert ids(member_client, sort="last_watched_at", order="desc")[0] == second.id


def test_finishing_clears_only_your_own_progress(client, member_client, add_video):
    video = add_video(title="Short", duration_sec=100.0)
    _progress(client, video.id, 50)
    _progress(member_client, video.id, 50)
    _progress(client, video.id, 95)  # >= 90 %: finished for the admin only
    assert client.get(f"/api/videos/{video.id}").json()["last_position_sec"] == 0.0
    assert (
        member_client.get(f"/api/videos/{video.id}").json()["last_position_sec"] == 50.0
    )


def test_progress_upserts_one_row_per_user_and_video(
    client, add_video, session, admin_user
):
    video = add_video(duration_sec=500.0)
    for seconds in (10, 20, 30):
        _progress(client, video.id, seconds)
    rows = session.exec(select(UserVideoState)).all()
    assert [(r.user_id, r.video_id, r.position_sec) for r in rows] == [
        (admin_user.id, video.id, 30.0)
    ]


def _late_progress(c, video_id, seconds, watched_at):
    resp = c.patch(
        f"/api/videos/{video_id}/progress",
        json={"position_sec": seconds, "watched_at": watched_at.isoformat()},
    )
    assert resp.status_code == 204


def _watched(c, video_id):
    body = c.get(f"/api/videos/{video_id}").json()
    return body["last_position_sec"], body["last_watched_at"]


def test_a_late_save_does_not_rewind_newer_progress(client, add_video):
    video = add_video(duration_sec=600.0)
    queued_at = datetime.now(UTC) - timedelta(minutes=10)
    # Watched on another device after the phone queued its save offline.
    _progress(client, video.id, 300)
    _late_progress(client, video.id, 120, queued_at)
    assert _watched(client, video.id)[0] == 300.0


def test_a_late_save_applies_when_it_is_the_newest(client, add_video):
    video = add_video(duration_sec=600.0)
    _late_progress(client, video.id, 60, datetime.now(UTC) - timedelta(hours=2))
    queued_at = datetime.now(UTC) - timedelta(hours=1)
    _late_progress(client, video.id, 120, queued_at)
    position, watched_at = _watched(client, video.id)
    assert position == 120.0
    # Stamped with when it was watched, so history orders it truthfully.
    assert datetime.fromisoformat(watched_at) == queued_at
    # An older late save loses to it in turn.
    _late_progress(client, video.id, 90, queued_at - timedelta(minutes=1))
    assert _watched(client, video.id)[0] == 120.0


def test_a_late_save_from_the_future_counts_as_now(client, add_video):
    video = add_video(duration_sec=600.0)
    before = datetime.now(UTC)
    _late_progress(client, video.id, 60, before + timedelta(days=1))
    position, watched_at = _watched(client, video.id)
    assert position == 60.0
    assert before <= datetime.fromisoformat(watched_at) <= datetime.now(UTC)
    # A live save right after still wins: the skewed clock did not pin it.
    _progress(client, video.id, 90)
    assert _watched(client, video.id)[0] == 90.0


def test_late_saves_are_per_user(client, member_client, add_video):
    video = add_video(duration_sec=600.0)
    _progress(client, video.id, 300)
    _late_progress(
        member_client, video.id, 120, datetime.now(UTC) - timedelta(minutes=5)
    )
    assert _watched(member_client, video.id)[0] == 120.0
    assert _watched(client, video.id)[0] == 300.0


def test_progress_for_a_missing_video_is_404(client):
    assert (
        client.patch("/api/videos/999/progress", json={"position_sec": 10}).status_code
        == 404
    )


def test_deleting_a_video_removes_everyones_history(
    client, member_client, add_video, session
):
    video = add_video(duration_sec=200.0)
    _progress(client, video.id, 60)
    _progress(member_client, video.id, 60)
    assert client.delete(f"/api/videos/{video.id}").status_code == 204
    session.expire_all()
    assert session.exec(select(UserVideoState)).all() == []


def test_metadata_edits_are_shared(client, member_client, add_video):
    video = add_video(title="Before")
    assert (
        member_client.patch(
            f"/api/videos/{video.id}", json={"title": "After", "notes": "hi"}
        ).status_code
        == 200
    )
    seen = client.get(f"/api/videos/{video.id}").json()
    assert (seen["title"], seen["notes"]) == ("After", "hi")
