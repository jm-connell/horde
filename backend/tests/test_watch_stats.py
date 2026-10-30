"""Watch time from progress saves, and the History stats built from it."""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import Session, select

from app import config
from app.models import UserWatchTime, Video
from app.services import watch_stats

T0 = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def __call__(self) -> datetime:
        return self.now

    def at(self, seconds: float) -> None:
        self.now = T0 + timedelta(seconds=seconds)


@pytest.fixture
def clock(monkeypatch) -> Clock:
    fake = Clock()
    monkeypatch.setattr("app.services.watch_stats.utcnow", fake)
    monkeypatch.setattr("app.services.user_state.utcnow", fake)
    return fake


def _save(c, video_id, seconds, *, finished=False, at=None):
    body: dict[str, object] = {"position_sec": seconds}
    if finished:
        body["finished"] = True
    if at is not None:
        body["watched_at"] = at.isoformat()
    resp = c.patch(f"/api/videos/{video_id}/progress", json=body)
    assert resp.status_code == 204


def _play(c, clock, video_id, steps):
    """``steps``: (wall-clock second, position) pairs, saved in order."""
    for wall, position in steps:
        clock.at(wall)
        _save(c, video_id, position)


def _rows(engine, user_id=None):
    with Session(engine) as session:
        query = select(UserWatchTime).order_by(UserWatchTime.hour_start)
        if user_id is not None:
            query = query.where(UserWatchTime.user_id == user_id)
        return session.exec(query).all()


def _seconds(engine, user_id=None) -> float:
    return sum(r.seconds for r in _rows(engine, user_id))


# --- Counting -------------------------------------------------------------------


def test_playing_counts_the_seconds_watched(client, add_video, init_db, clock):
    video = add_video(duration_sec=600.0)
    _play(client, clock, video.id, [(0, 0), (5, 5), (10, 10), (30, 30)])
    assert _seconds(init_db["engine"]) == 30
    (row,) = _rows(init_db["engine"])
    assert row.channel == "Alpha"
    assert row.hour_start.replace(tzinfo=UTC) == T0
    assert row.finished == 0


def test_a_seek_forward_is_not_watching(client, add_video, init_db, clock):
    video = add_video(duration_sec=900.0)
    _play(client, clock, video.id, [(0, 0), (10, 10), (15, 600), (25, 610)])
    assert _seconds(init_db["engine"]) == 20


def test_a_seek_back_counts_only_what_plays_after_it(client, add_video, init_db, clock):
    video = add_video(duration_sec=900.0)
    _play(client, clock, video.id, [(0, 0), (60, 60), (65, 30), (75, 40)])
    assert _seconds(init_db["engine"]) == 70


def test_double_speed_counts_the_content_seconds(client, add_video, init_db, clock):
    video = add_video(duration_sec=900.0)
    _play(client, clock, video.id, [(0, 0), (5, 10), (10, 20)])
    assert _seconds(init_db["engine"]) == 20


def test_a_pause_does_not_stop_the_next_seconds_counting(
    client, add_video, init_db, clock
):
    video = add_video(duration_sec=900.0)
    _play(client, clock, video.id, [(0, 0), (10, 10), (3600, 20)])
    assert _seconds(init_db["engine"]) == 20


def test_the_tail_after_ninety_percent_counts_on_finish(
    client, add_video, init_db, clock
):
    video = add_video(duration_sec=100.0)
    # From 90% on the player saves 0, then reports the finish.
    _play(client, clock, video.id, [(0, 0), (85, 85), (92, 0), (97, 0)])
    clock.at(100)
    _save(client, video.id, 0, finished=True)
    (row,) = _rows(init_db["engine"])
    assert row.seconds == 100
    assert row.finished == 1


def test_a_finish_after_a_seek_to_the_end_counts_the_time_it_took(
    client, add_video, init_db, clock
):
    video = add_video(duration_sec=1000.0)
    _play(client, clock, video.id, [(0, 0), (100, 100), (105, 0)])
    clock.at(120)
    _save(client, video.id, 0, finished=True)
    # 100 played, then at most 20 s of tail (at up to double speed, plus slack).
    assert _seconds(init_db["engine"]) == 100 + 20 * 2 + 3


def test_a_seek_after_a_pause_is_not_the_paused_time(client, add_video, init_db, clock):
    video = add_video(duration_sec=3600.0)
    _play(client, clock, video.id, [(0, 0), (10, 10), (3600, 1800), (3605, 1805)])
    assert _seconds(init_db["engine"]) == 15


def test_a_skip_between_two_saves_is_not_watching(client, add_video, init_db, clock):
    video = add_video(duration_sec=900.0)
    _play(client, clock, video.id, [(0, 0), (5, 5), (10, 25), (15, 30)])
    assert _seconds(init_db["engine"]) == 10


def test_a_seek_from_yesterdays_place_after_a_restart_is_not_watching(
    client, add_video, init_db, clock
):
    video = add_video(duration_sec=3600.0)
    _play(client, clock, video.id, [(0, 0), (5, 5)])
    init_db["ctx"].watch_refs = watch_stats.WatchRefs()
    _play(client, clock, video.id, [(86400, 2000), (86405, 2005)])
    assert _seconds(init_db["engine"]) == 10


def test_after_a_restart_the_saved_position_is_the_reference(
    client, add_video, init_db, clock
):
    video = add_video(duration_sec=900.0)
    _play(client, clock, video.id, [(0, 0), (60, 60)])
    init_db["ctx"].watch_refs = watch_stats.WatchRefs()
    _play(client, clock, video.id, [(70, 70)])
    assert _seconds(init_db["engine"]) == 70


def test_an_offline_save_counts_in_the_hour_it_was_made(
    client, add_video, init_db, clock
):
    video = add_video(duration_sec=900.0)
    clock.at(0)
    _save(client, video.id, 0)
    clock.at(5 * 3600)  # back online five hours later
    reached = T0 + timedelta(hours=2)
    _save(client, video.id, 0, at=reached - timedelta(seconds=300))
    _save(client, video.id, 300, at=reached)
    (row,) = _rows(init_db["engine"])
    assert row.seconds == 300
    assert row.hour_start.replace(tzinfo=UTC) == T0 + timedelta(hours=2)


def test_a_whole_offline_session_arrives_as_one_save(client, add_video, init_db, clock):
    video = add_video(duration_sec=1800.0)
    _play(client, clock, video.id, [(0, 0), (5, 5)])
    # The queue keeps only the newest save per video: 20 minutes in one.
    clock.at(3 * 3600)
    _save(client, video.id, 1205, at=T0 + timedelta(seconds=5 + 1200))
    assert _seconds(init_db["engine"]) == 1205


def test_a_stale_offline_save_counts_nothing(client, add_video, init_db, clock):
    video = add_video(duration_sec=900.0)
    _play(client, clock, video.id, [(0, 0), (60, 60)])
    # Queued on a phone before the live saves above, flushed afterwards.
    clock.at(120)
    _save(client, video.id, 400, at=T0 - timedelta(seconds=10))
    assert _seconds(init_db["engine"]) == 60


def test_watch_time_is_per_user(
    client, member_client, add_video, init_db, clock, admin_user, member_user
):
    video = add_video(duration_sec=900.0)
    _play(client, clock, video.id, [(0, 0), (10, 10)])
    _play(member_client, clock, video.id, [(20, 300), (25, 305), (30, 310)])
    assert _seconds(init_db["engine"], admin_user.id) == 10
    assert _seconds(init_db["engine"], member_user.id) == 10
    admin_stats = client.get("/api/history/stats", params={"range": "all"}).json()
    member_stats = member_client.get(
        "/api/history/stats", params={"range": "all"}
    ).json()
    assert admin_stats["totals"]["watch_seconds"] == 10
    assert member_stats["totals"]["watch_seconds"] == 10


def test_deleting_the_video_keeps_the_watch_time(client, add_video, init_db, clock):
    video = add_video(duration_sec=900.0, channel="Keepers", title="Gone soon")
    _play(client, clock, video.id, [(0, 0), (10, 10)])
    assert client.delete(f"/api/videos/{video.id}").status_code == 204
    (row,) = _rows(init_db["engine"])
    assert row.video_id is None
    assert row.seconds == 10
    clock.at(20)
    stats = client.get("/api/history/stats", params={"range": "all"}).json()
    assert stats["totals"]["watch_seconds"] == 10
    assert stats["channels"] == [
        {"name": "Keepers", "seconds": 10.0, "videos": 0, "youtube_views": 0}
    ]


def test_a_restore_from_the_trash_links_the_watch_time_again(
    client, add_video, init_db, clock, monkeypatch
):
    monkeypatch.setattr(config, "TRASH_DAYS", 7)
    video = add_video(duration_sec=900.0, write_file=True)
    _play(client, clock, video.id, [(0, 0), (10, 10)])
    resp = client.delete(f"/api/videos/{video.id}?delete_file=true")
    assert resp.status_code == 204
    assert _rows(init_db["engine"])[0].video_id is None
    entry_id = int(resp.headers["x-horde-trash-entry"])
    assert client.post(f"/api/trash/{entry_id}/restore").status_code == 200
    assert _rows(init_db["engine"])[0].video_id == video.id


def test_deleting_the_account_deletes_its_watch_time(
    client, member_client, add_video, init_db, clock, member_user
):
    video = add_video(duration_sec=900.0)
    _play(member_client, clock, video.id, [(0, 0), (10, 10)])
    assert client.delete(f"/api/users/{member_user.id}").status_code == 204
    assert _rows(init_db["engine"]) == []


# --- Stats ----------------------------------------------------------------------

NOW = datetime(2026, 3, 10, 18, 30, tzinfo=UTC)  # a Tuesday


def _hours_ago(hours: float) -> datetime:
    return (NOW - timedelta(hours=hours)).replace(minute=0, second=0, microsecond=0)


@pytest.fixture
def seeded(session, add_video, admin_user, member_user, set_watch):
    """A week and a bit of watching for the admin (and some for the member)."""
    north = add_video(title="North", channel="Northwind", tags=["ambient", "field"])
    harbor = add_video(title="Harbor", channel="Northwind", tags=["Ambient"])
    kiln = add_video(title="Kiln", channel="Kiln", tags=["craft"])
    old = add_video(title="Old favourite", channel="Kiln")
    add_video(title="Inbox", channel=None, needs_review=True)
    for video in (north, harbor, kiln, old):
        video.added_at = NOW - timedelta(days=40)
        session.add(video)
    session.commit()

    def row(user, video, hours_ago, seconds, finished=0):
        session.add(
            UserWatchTime(
                user_id=user.id,
                video_id=video.id,
                channel=video.channel,
                hour_start=_hours_ago(hours_ago),
                seconds=seconds,
                finished=finished,
            )
        )

    row(admin_user, north, 0, 600, 1)  # today 18:00
    row(admin_user, harbor, 0, 300)  # today 18:00
    row(admin_user, kiln, 24, 1200, 1)  # yesterday 18:00
    row(admin_user, north, 48, 60)  # two days ago
    row(admin_user, kiln, 24 * 5, 900)  # five days ago: breaks the streak
    row(admin_user, kiln, 24 * 9, 1800)  # nine days ago: last week only
    row(member_user, kiln, 0, 5000, 1)
    session.commit()
    # Watched before watch time was recorded: counts as started, not as time.
    set_watch(admin_user, old, 30.0, NOW - timedelta(days=3))
    return {"north": north, "harbor": harbor, "kiln": kiln, "old": old}


def _stats(session, user, range_key="7d", tz="UTC"):
    name, zone = watch_stats.resolve_tz(tz)
    return watch_stats.compute(session, user.id, range_key, name, zone, now=NOW)


def test_stats_add_up_the_range(session, seeded, admin_user):
    stats = _stats(session, admin_user)
    assert stats.start_day == "2026-03-04"
    assert stats.end_day == "2026-03-10"
    assert len(stats.days) == 7
    assert [d.seconds for d in stats.days] == [0, 900, 0, 0, 60, 1200, 900]
    assert [d.finished for d in stats.days][-2:] == [1, 1]
    totals = stats.totals
    assert totals.watch_seconds == 3060
    assert totals.previous_watch_seconds == 1800
    assert totals.videos_started == 4  # north, harbor, kiln, old (from history)
    assert totals.videos_finished == 2
    assert totals.active_days == 4
    assert totals.current_streak_days == 3
    assert stats.best_day is not None and stats.best_day.day == "2026-03-09"
    assert [(c.name, c.seconds, c.videos) for c in stats.channels] == [
        ("Kiln", 2100.0, 1),
        ("Northwind", 960.0, 2),
    ]
    # Tags compare case-insensitively and count each video once per tag.
    assert [(t.tag.lower(), t.seconds) for t in stats.tags] == [
        ("craft", 2100.0),
        ("ambient", 960.0),
        ("field", 660.0),
    ]
    assert stats.hours is not None
    assert stats.hours[1][18] == 900  # Tuesday 18:00 (today)
    assert stats.hours[0][18] == 1200  # Monday
    assert sum(map(sum, stats.hours)) == 3060
    library = stats.library
    assert library.total_videos == 4  # the review inbox is not the library
    assert library.added_in_range == 0
    assert library.watched_videos == 1
    assert library.watched_share == 0.25


def test_all_time_starts_at_the_first_watched_day(session, seeded, admin_user):
    stats = _stats(session, admin_user, "all")
    assert stats.start_day == "2026-03-01"
    assert stats.totals.watch_seconds == 4860
    assert stats.totals.previous_watch_seconds is None
    assert stats.library.added_in_range == 4


def test_days_follow_the_viewers_time_zone(session, seeded, admin_user):
    # 18:00 UTC is 03:00 the next morning in Tokyo.
    stats = _stats(session, admin_user, tz="Asia/Tokyo")
    assert stats.end_day == "2026-03-11"
    assert stats.days[-1].seconds == 900
    assert stats.hours is not None and stats.hours[2][3] == 900  # Wednesday 03:00


def test_a_new_user_gets_empty_stats(session, add_video, member_user):
    stats = _stats(session, member_user, "30d")
    assert stats.totals.watch_seconds == 0
    assert stats.totals.current_streak_days == 0
    assert stats.best_day is None
    assert stats.hours is None
    assert len(stats.days) == 30


def test_the_endpoint_validates_range_and_time_zone(client):
    assert client.get("/api/history/stats").status_code == 200
    bad_range = client.get("/api/history/stats", params={"range": "2d"})
    assert bad_range.status_code == 422
    bad_tz = client.get("/api/history/stats", params={"tz": "Mars/Olympus"})
    assert bad_tz.status_code == 422
    assert bad_tz.json()["code"] == "invalid_timezone"
    ok = client.get("/api/history/stats", params={"range": "365d", "tz": "UTC"})
    assert ok.json()["tz"] == "UTC"
    assert len(ok.json()["days"]) == 365


def test_stats_need_a_session(anon_client):
    assert anon_client.get("/api/history/stats").status_code == 401


def test_stats_stay_fast_with_a_year_of_rows(session, add_video, admin_user):
    videos = [
        add_video(title=f"Perf {n}", channel=f"Channel {n % 12}", tags=[f"t{n % 30}"])
        for n in range(60)
    ]
    rows = [
        UserWatchTime(
            user_id=admin_user.id,
            video_id=videos[n % len(videos)].id,
            channel=f"Channel {n % 12}",
            hour_start=_hours_ago(n * 1.7),
            seconds=300,
            finished=n % 3 == 0,
        )
        for n in range(5000)
    ]
    session.add_all(rows)
    session.commit()
    best = float("inf")
    for _ in range(3):
        started = time.perf_counter()
        stats = _stats(session, admin_user, "all", tz="Europe/Berlin")
        best = min(best, time.perf_counter() - started)
    assert stats.totals.watch_seconds == 5000 * 300
    # About 20 ms on a laptop; generous so a busy CI machine does not flake.
    assert best < 0.5


def test_a_video_row_without_a_channel_is_left_out_of_top_channels(
    session, add_video, admin_user
):
    video = add_video(channel=None, title="Loose")
    session.add(
        UserWatchTime(
            user_id=admin_user.id,
            video_id=video.id,
            hour_start=_hours_ago(1),
            seconds=50,
        )
    )
    session.commit()
    assert session.get(Video, video.id) is not None
    stats = _stats(session, admin_user)
    assert stats.totals.watch_seconds == 50
    assert stats.channels == []
