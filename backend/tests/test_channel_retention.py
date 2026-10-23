"""Per-channel retention rules: what they remove, what they never touch, the API."""

from __future__ import annotations

import threading
import time
from datetime import timedelta

import pytest
from sqlmodel import select

from app import config
from app.models import (
    ChannelAutodownload,
    ChannelCatalog,
    ChannelCatalogSkip,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
    ChannelRetention,
    Playlist,
    PlaylistItem,
    RetentionKeep,
    TrashEntry,
    UserVideoState,
    Video,
    utcnow,
)
from app.services import channel_autodownload as ad
from app.services import channel_retention as retention
from app.services import trash, user_state

CHANNEL = "News Daily"
URL = "https://www.youtube.com/@newsdaily"


@pytest.fixture(autouse=True)
def trash_on(monkeypatch):
    monkeypatch.setattr(config, "TRASH_DAYS", 7)


def _days_ago(n: float):
    return utcnow() - timedelta(days=n)


def _rule(session, *, enabled=True, channel=CHANNEL, **limits) -> ChannelRetention:
    return retention.save(
        session, channel, enabled=enabled, rule=retention.Rule(**limits)
    )


def _run(session, row=None, **kwargs) -> int:
    row = row or retention.get(session, CHANNEL)
    return retention.apply_rule(session, row, **kwargs)


def _titles(session, channel=CHANNEL) -> set[str]:
    return {
        v.title
        for v in session.exec(select(Video).where(Video.channel == channel)).all()
    }


def _news(add_video, n: int, *, start_age=10.0, **fields):
    """``n`` videos of the channel, the first the oldest (``start_age`` days old)."""
    return [
        add_video(
            channel=CHANNEL,
            title=f"Episode {i}",
            write_file=True,
            added_at=_days_ago(start_age - i),
            **fields,
        )
        for i in range(n)
    ]


# --- Each limit alone ---------------------------------------------------------


def test_keep_latest_keeps_the_newest_by_publish_date(session, add_video):
    # Added in the opposite order to how they were published.
    for i, published in enumerate([5, 1, 9, 3]):
        add_video(
            channel=CHANNEL,
            title=f"Pub {published}",
            published_at=_days_ago(published),
            added_at=_days_ago(40 - i),
            write_file=True,
        )
    _rule(session, keep_latest=2)

    assert _run(session) == 2
    assert _titles(session) == {"Pub 1", "Pub 3"}


def test_keep_latest_falls_back_to_the_added_date(session, add_video):
    old = add_video(
        channel=CHANNEL, title="Old", added_at=_days_ago(9), write_file=True
    )
    add_video(channel=CHANNEL, title="Mid", added_at=_days_ago(5), write_file=True)
    # Published long ago but added most recently: no publish date to go by for the others.
    add_video(
        channel=CHANNEL,
        title="New",
        published_at=_days_ago(2),
        added_at=_days_ago(3),
        write_file=True,
    )
    _rule(session, keep_latest=2)

    _run(session)

    assert _titles(session) == {"Mid", "New"}
    assert session.get(Video, old.id) is None


def test_max_age_removes_what_was_added_too_long_ago(session, add_video):
    add_video(channel=CHANNEL, title="Ancient", added_at=_days_ago(90), write_file=True)
    add_video(channel=CHANNEL, title="Recent", added_at=_days_ago(10), write_file=True)
    _rule(session, max_age_days=30)

    assert _run(session) == 1
    assert _titles(session) == {"Recent"}


def test_remove_watched_needs_a_finished_video_and_the_wait(
    session, add_video, admin_user, member_user
):
    seen, partly, unseen = _news(add_video, 3)
    user_state.record_progress(session, admin_user.id, seen.id, 0, finished=True)
    user_state.record_progress(session, member_user.id, partly.id, 30)  # partway
    row = _rule(session, remove_watched_after_days=14)

    # Finished just now: inside the wait.
    assert _run(session, row, now=utcnow() + timedelta(days=13)) == 0
    # After the wait, the finished one goes and the others stay.
    assert _run(session, row, now=utcnow() + timedelta(days=15)) == 1
    assert _titles(session) == {partly.title, unseen.title}


def test_a_half_watch_that_expired_is_not_finished(session, add_video, admin_user):
    """Expiry zeroes the position as a finish does, but never stamps ``finished_at``."""
    (video,) = _news(add_video, 1)
    user_state.record_progress(session, admin_user.id, video.id, 40)
    user_state.expire_stale(session, utcnow() + timedelta(days=1))
    state = session.exec(select(UserVideoState)).one()
    session.refresh(state)
    assert state.position_sec == 0 and state.finished_at is None
    row = _rule(session, remove_watched_after_days=1)

    assert _run(session, row, now=utcnow() + timedelta(days=30)) == 0


def test_watching_again_clears_finished(session, add_video, admin_user):
    (video,) = _news(add_video, 1)
    user_state.record_progress(session, admin_user.id, video.id, 0, finished=True)
    assert session.exec(select(UserVideoState)).one().finished_at is not None

    user_state.record_progress(session, admin_user.id, video.id, 25)
    session.expire_all()
    assert session.exec(select(UserVideoState)).one().finished_at is None


def test_other_channels_are_left_alone(session, add_video):
    add_video(
        channel="Other", title="Other old", added_at=_days_ago(90), write_file=True
    )
    add_video(channel=CHANNEL, title="Old", added_at=_days_ago(90), write_file=True)
    _rule(session, max_age_days=30)

    _run(session)

    assert _titles(session, "Other") == {"Other old"}


# --- Combined ------------------------------------------------------------------


def test_limits_combine_and_the_first_matching_one_is_the_reason(session, add_video):
    episodes = _news(add_video, 6, start_age=60.5)  # 60.5, 59.5, ... 55.5 days old
    _rule(session, keep_latest=4, max_age_days=58)

    assert _run(session) == 3  # #0, #1 by count; #2 (58.5 days) by age
    assert _titles(session) == {e.title for e in episodes[3:]}
    reasons = {e.title: e.reason for e in session.exec(select(TrashEntry)).all()}
    assert reasons == {
        "Episode 0": "Retention: keep latest 4",
        "Episode 1": "Retention: keep latest 4",
        "Episode 2": "Retention: older than 58 days",
    }


def test_a_rule_that_is_off_or_empty_removes_nothing(session, add_video):
    _news(add_video, 4, start_age=90)
    _rule(session, enabled=False, keep_latest=1)
    assert retention.run_all() == 0
    assert len(_titles(session)) == 4
    # Enabled with no limit (stored by hand): nothing to apply either.
    row = retention.get(session, CHANNEL)
    row.enabled = True
    row.keep_latest = None
    session.add(row)
    session.commit()
    assert retention.run_all() == 0
    assert len(_titles(session)) == 4


# --- What is never removed -----------------------------------------------------


def _all_exempt_setup(session, add_video, admin_user, member_user):
    old = {}
    for name in (
        "plain",
        "playlist",
        "notes",
        "progress",
        "stale",
        "blank",
        "restored",
    ):
        old[name] = add_video(
            channel=CHANNEL,
            title=name,
            write_file=True,
            added_at=_days_ago(100),
        )
    playlist = Playlist(name="Mine")
    session.add(playlist)
    session.commit()
    session.add(PlaylistItem(playlist_id=playlist.id, video_id=old["playlist"].id))
    row = session.get(Video, old["notes"].id)
    row.notes = "remember this"
    blank = session.get(Video, old["blank"].id)
    blank.notes = "   "
    session.add_all([row, blank])
    session.add(
        UserVideoState(
            user_id=member_user.id,
            video_id=old["progress"].id,
            position_sec=40,
            last_watched_at=_days_ago(2),
        )
    )
    # Partway, but not touched for two weeks: not "right now".
    session.add(
        UserVideoState(
            user_id=member_user.id,
            video_id=old["stale"].id,
            position_sec=40,
            last_watched_at=_days_ago(14),
        )
    )
    session.add(RetentionKeep(video_id=old["restored"].id))
    session.commit()
    return old


def test_exceptions_are_never_removed(session, add_video, admin_user, member_user):
    _all_exempt_setup(session, add_video, admin_user, member_user)
    add_video(channel=CHANNEL, title="fresh", added_at=_days_ago(0.2), write_file=True)
    row = _rule(session, max_age_days=30, keep_latest=1)  # `fresh` is the newest

    assert _run(session, row) == 3  # plain, stale and blank notes
    assert _titles(session) == {"playlist", "notes", "progress", "restored", "fresh"}


def test_a_new_video_is_kept_even_when_it_is_past_the_count(session, add_video):
    for i in range(3):
        add_video(
            channel=CHANNEL,
            title=f"Hour {i}",
            added_at=_days_ago(0.05 * (i + 1)),
            write_file=True,
        )
    _rule(session, keep_latest=1)

    assert _run(session) == 0
    assert len(_titles(session)) == 3


def test_finished_by_one_person_but_partway_for_another_stays(
    session, add_video, admin_user, member_user
):
    (video,) = _news(add_video, 1, start_age=100)
    user_state.record_progress(session, admin_user.id, video.id, 0, finished=True)
    user_state.record_progress(session, member_user.id, video.id, 50)
    row = _rule(session, remove_watched_after_days=1)

    assert _run(session, row, now=utcnow() + timedelta(days=5)) == 0


def test_videos_that_are_not_ready_or_need_review_are_ignored(session, add_video):
    from app.models import VideoStatus

    add_video(
        channel=CHANNEL,
        title="Downloading",
        status=VideoStatus.downloading,
        added_at=_days_ago(90),
    )
    add_video(
        channel=CHANNEL, title="Review", needs_review=True, added_at=_days_ago(90)
    )
    _rule(session, max_age_days=30)

    assert _run(session) == 0


# --- Preview, trash, restore ---------------------------------------------------


def test_preview_is_what_a_run_removes(
    client, session, add_video, admin_user, member_user
):
    _all_exempt_setup(session, add_video, admin_user, member_user)
    body = {"channel": CHANNEL, "max_age_days": 30}

    preview = client.post("/api/channels/retention/preview", json=body)

    assert preview.status_code == 200
    data = preview.json()
    assert data["count"] == 3
    assert data["kept_by_exception"] == 4
    assert data["total_bytes"] == sum(i["size_bytes"] for i in data["would_remove"])
    assert {i["reason"] for i in data["would_remove"]} == {
        "Retention: older than 30 days"
    }
    assert session.exec(select(TrashEntry)).all() == []  # nothing happened

    _rule(session, max_age_days=30)
    _run(session)
    trashed = {e.title for e in session.exec(select(TrashEntry)).all()}
    assert trashed == {i["title"] for i in data["would_remove"]}


def test_preview_caps_the_list_but_counts_everything(
    client, session, add_video, monkeypatch
):
    from app.api import channels

    monkeypatch.setattr(channels, "PREVIEW_LIST_LIMIT", 2)
    _news(add_video, 5, start_age=100)
    data = client.post(
        "/api/channels/retention/preview",
        json={"channel": CHANNEL, "max_age_days": 30},
    ).json()
    assert data["count"] == 5 and len(data["would_remove"]) == 2


def test_removals_land_in_the_trash_with_the_reason_and_can_be_restored(
    client, session, add_video, init_db
):
    (old, _new) = _news(add_video, 2, start_age=100)
    media = init_db["downloads"] / old.file_path
    _rule(session, keep_latest=1)

    assert _run(session) == 1

    assert not media.exists()
    listing = client.get("/api/trash").json()["items"]
    assert [(i["title"], i["reason"], i["trashed_by"]) for i in listing] == [
        ("Episode 0", "Retention: keep latest 1", None)
    ]
    row = retention.get(session, CHANNEL)
    session.refresh(row)
    assert row.last_run_at is not None
    assert row.last_removed_count == 1 and row.last_removed_at is not None

    assert client.post(f"/api/trash/{listing[0]['id']}/restore").status_code == 200
    assert media.exists()
    assert _titles(session) == {"Episode 0", "Episode 1"}


def test_a_restored_video_is_not_removed_again(client, session, add_video):
    _news(add_video, 2, start_age=100)
    row = _rule(session, keep_latest=1)
    _run(session, row)
    entry = session.exec(select(TrashEntry)).one()
    entry_id, video_id = entry.id, entry.video_id

    assert client.post(f"/api/trash/{entry_id}/restore").status_code == 200

    assert _run(session, row) == 0
    assert _titles(session) == {"Episode 0", "Episode 1"}
    assert session.exec(select(RetentionKeep)).one().video_id == video_id


def test_a_run_keeps_going_past_a_video_that_cannot_be_moved(
    session, add_video, monkeypatch
):
    _news(add_video, 4, start_age=100)
    row = _rule(session, keep_latest=1)
    real = trash.trash_video

    def flaky(session_, video, by, reason=None):
        if video.title == "Episode 0":
            raise trash.TrashCrossDevice("different filesystem")
        return real(session_, video, by, reason)

    monkeypatch.setattr(trash, "trash_video", flaky)

    assert _run(session, row) == 2
    assert _titles(session) == {"Episode 0", "Episode 3"}


def test_nothing_is_removed_while_the_trash_is_off(session, add_video, monkeypatch):
    monkeypatch.setattr(config, "TRASH_DAYS", 0)
    _news(add_video, 3, start_age=100)
    _rule(session, keep_latest=1)

    assert retention.run_all() == 0
    assert len(_titles(session)) == 3


def test_run_all_applies_every_enabled_rule(session, add_video):
    _news(add_video, 3, start_age=100)
    add_video(
        channel="Other", title="Old other", added_at=_days_ago(90), write_file=True
    )
    _rule(session, keep_latest=1)
    _rule(session, channel="Other", max_age_days=30)
    _rule(session, channel="Third", enabled=False, max_age_days=1)

    assert retention.run_all() == 3
    assert _titles(session, "Other") == set()


def test_the_worker_applies_the_rules_and_stops(session, add_video, monkeypatch):
    _news(add_video, 3, start_age=100)
    _rule(session, keep_latest=1)
    monkeypatch.setattr(retention, "STARTUP_DELAY_SEC", 0.05)
    worker = retention.create_worker()
    worker.start()
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            session.expire_all()
            if len(_titles(session)) == 1:
                break
            time.sleep(0.05)
        assert len(_titles(session)) == 1
    finally:
        assert worker.stop(timeout=10)
    assert not any(t.name == retention.WORKER_NAME for t in threading.enumerate())


# --- Auto-download does not bring removed videos back ---------------------------


def test_autodownload_does_not_refetch_what_retention_removed(session, add_video):
    catalog = ChannelCatalog(
        channel_url=URL,
        channel_name=CHANNEL,
        status=ChannelCatalogStatus.ready,
        complete=True,
    )
    session.add(catalog)
    session.commit()
    old = add_video(
        channel=CHANNEL,
        channel_url=URL,
        yt_id="oldvideo001",
        title="Old",
        added_at=_days_ago(100),
        write_file=True,
    )
    add_video(
        channel=CHANNEL,
        channel_url=URL,
        yt_id="newvideo001",
        title="New",
        added_at=_days_ago(1),
        write_file=True,
    )
    rows = [
        ChannelCatalogVideo(
            catalog_id=catalog.id,
            yt_id=yt,
            url=f"https://www.youtube.com/watch?v={yt}",
            position=pos,
        )
        for pos, yt in enumerate(["newvideo001", "oldvideo001"])
    ]
    policy = ChannelAutodownload(
        channel_url=URL, channel_name=CHANNEL, enabled=True, previous_mode="all"
    )
    session.add_all([*rows, policy])
    session.commit()
    _rule(session, max_age_days=30)

    assert _run(session) == 1
    assert session.get(Video, old.id) is None

    session.expire_all()
    deleted = [
        s.yt_id
        for s in session.exec(select(ChannelCatalogSkip)).all()
        if s.reason == "deleted"
    ]
    assert deleted == ["oldvideo001"]
    eligible = ad._eligible_rows(session, policy, rows, queued_ids=set())
    assert eligible == []  # one is in the library, the other was removed
    assert ad.enqueue_catalog_row(session, rows[1], policy) is None


# --- Renaming a channel ----------------------------------------------------------


def test_a_rename_carries_the_rule_along(client, session, add_video):
    _news(add_video, 3, start_age=100)
    _rule(session, keep_latest=1)

    resp = client.patch(
        "/api/channels", json={"old_name": CHANNEL, "new_name": "Daily News"}
    )

    assert resp.status_code == 200
    assert retention.get(session, CHANNEL) is None
    moved = retention.get(session, "Daily News")
    assert moved is not None and moved.keep_latest == 1
    assert resp.json() == {"updated": 3, "retention_disabled": False}
    assert moved.enabled
    assert retention.run_all() == 2
    assert _titles(session, "Daily News") == {"Episode 2"}


def test_a_rename_onto_a_channel_with_a_rule_keeps_that_rule(
    client, session, add_video
):
    _news(add_video, 1)
    add_video(channel="Daily News", title="Existing", write_file=True)
    _rule(session, keep_latest=1)
    _rule(session, channel="Daily News", max_age_days=9)

    resp = client.patch(
        "/api/channels", json={"old_name": CHANNEL, "new_name": "Daily News"}
    )

    session.expire_all()
    assert retention.get(session, CHANNEL) is None
    kept = retention.get(session, "Daily News")
    assert kept.keep_latest is None and kept.max_age_days == 9
    # The two channels merge: the rule no longer means what its author meant.
    assert not kept.enabled and resp.json()["retention_disabled"] is True


def test_a_merge_does_not_carry_a_rule_onto_the_other_channels_videos(
    client, session, add_video
):
    """Renaming onto a channel with videos must not let a keep-latest-1 rule
    trash the other channel's library."""
    add_video(channel=CHANNEL, title="a1", write_file=True, added_at=_days_ago(50))
    for i in range(3):
        add_video(
            channel="Other",
            title=f"other{i}",
            write_file=True,
            added_at=_days_ago(40 - i),
        )
    _rule(session, keep_latest=1)

    resp = client.patch(
        "/api/channels", json={"old_name": CHANNEL, "new_name": "Other"}
    )

    assert resp.json() == {"updated": 1, "retention_disabled": True}
    session.expire_all()
    moved = retention.get(session, "Other")
    assert moved.keep_latest == 1 and not moved.enabled
    assert retention.run_all() == 0
    assert len(_titles(session, "Other")) == 4


def test_a_merge_into_a_channel_with_a_rule_disables_that_rule_too(
    client, session, add_video
):
    """The other direction: the target's rule would reach the renamed videos."""
    add_video(channel=CHANNEL, title="mine", write_file=True, added_at=_days_ago(50))
    add_video(channel="Other", title="theirs", write_file=True, added_at=_days_ago(40))
    _rule(session, channel="Other", max_age_days=10)

    resp = client.patch(
        "/api/channels", json={"old_name": CHANNEL, "new_name": "Other"}
    )

    assert resp.json()["retention_disabled"] is True
    session.expire_all()
    assert not retention.get(session, "Other").enabled
    assert retention.run_all() == 0


def test_a_merge_reports_nothing_disabled_when_no_rule_was_on(
    client, session, add_video
):
    add_video(channel=CHANNEL, title="mine", write_file=True)
    add_video(channel="Other", title="theirs", write_file=True)
    _rule(session, enabled=False, keep_latest=1)

    resp = client.patch(
        "/api/channels", json={"old_name": CHANNEL, "new_name": "Other"}
    )

    assert resp.json() == {"updated": 1, "retention_disabled": False}


def test_renaming_to_the_same_name_keeps_the_rule(client, session, add_video):
    _news(add_video, 1)
    _rule(session, keep_latest=1)

    client.patch("/api/channels", json={"old_name": CHANNEL, "new_name": CHANNEL})

    assert retention.get(session, CHANNEL) is not None


# --- The API ----------------------------------------------------------------------


def test_get_returns_defaults_without_a_rule(client, add_video):
    _news(add_video, 1)

    data = client.get("/api/channels/retention", params={"channel": CHANNEL}).json()

    assert data["configured"] is False and data["enabled"] is False
    assert data["keep_latest"] is None and data["last_run_at"] is None
    assert data["trash_enabled"] is True
    assert [e["code"] for e in data["always_kept"]] == [
        "playlist",
        "notes",
        "in_progress",
        "new",
        "restored",
    ]


def test_put_saves_the_rule_and_wakes_the_worker(
    client, session, add_video, monkeypatch
):
    _news(add_video, 1)
    woken = []
    monkeypatch.setattr(retention, "wake_worker", lambda: woken.append(1))

    resp = client.put(
        "/api/channels/retention",
        json={
            "channel": CHANNEL,
            "enabled": True,
            "keep_latest": 20,
            "max_age_days": 90,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert (data["enabled"], data["keep_latest"], data["max_age_days"]) == (
        True,
        20,
        90,
    )
    assert data["remove_watched_after_days"] is None and data["configured"] is True
    assert woken == [1]
    assert (
        client.get("/api/channels/retention", params={"channel": CHANNEL}).json()
        == data
    )
    # Turning it off keeps the limits and does not run anything.
    off = client.put(
        "/api/channels/retention",
        json={"channel": CHANNEL, "enabled": False, "keep_latest": 20},
    ).json()
    assert off["enabled"] is False and off["max_age_days"] is None
    assert woken == [1]


@pytest.mark.parametrize(
    "body",
    [
        {"keep_latest": 0},
        {"keep_latest": -3},
        {"max_age_days": 0},
        {"max_age_days": 100000},
        {"remove_watched_after_days": 0},
        {"keep_latest": 1.5},
        {"channel": ""},
    ],
)
def test_put_rejects_bad_limits(client, add_video, body):
    _news(add_video, 1)
    resp = client.put(
        "/api/channels/retention", json={"channel": CHANNEL, "enabled": False, **body}
    )
    assert resp.status_code == 422


def test_put_needs_a_limit_to_turn_on_and_a_channel_that_exists(client, add_video):
    _news(add_video, 1)
    empty = client.put(
        "/api/channels/retention", json={"channel": CHANNEL, "enabled": True}
    )
    assert empty.status_code == 400 and empty.json()["code"] == "no_limit"
    missing = client.put(
        "/api/channels/retention",
        json={"channel": "Nobody", "enabled": True, "keep_latest": 3},
    )
    assert missing.status_code == 404 and missing.json()["code"] == "channel_not_found"


def test_channel_list_carries_a_summary_of_an_enabled_rule(client, session, add_video):
    _news(add_video, 1)
    add_video(channel="Other", title="x")
    _rule(session, keep_latest=20)
    _rule(session, channel="Other", enabled=False, keep_latest=3)

    by_name = {c["channel"]: c for c in client.get("/api/channels").json()}

    assert by_name[CHANNEL]["retention"] == {
        "enabled": True,
        "keep_latest": 20,
        "max_age_days": None,
        "remove_watched_after_days": None,
    }
    assert by_name["Other"]["retention"] is None


def test_members_read_the_rule_but_need_delete_rights_to_change_it(
    member_client, client, session, add_video
):
    _news(add_video, 1)
    _rule(session, keep_latest=5)
    body = {"channel": CHANNEL, "enabled": True, "keep_latest": 1}

    assert (
        member_client.get(
            "/api/channels/retention", params={"channel": CHANNEL}
        ).status_code
        == 200
    )
    assert member_client.put("/api/channels/retention", json=body).status_code == 403
    assert (
        member_client.post(
            "/api/channels/retention/preview", json={"channel": CHANNEL}
        ).status_code
        == 403
    )
    assert retention.get(session, CHANNEL).keep_latest == 5
    assert client.put("/api/channels/retention", json=body).status_code == 200


def test_trash_list_has_no_reason_for_a_manual_delete(client, add_video):
    video = add_video(channel=CHANNEL, write_file=True)
    client.delete(f"/api/videos/{video.id}?delete_file=true")
    (item,) = client.get("/api/trash").json()["items"]
    assert item["reason"] is None


def test_deleting_a_video_removes_its_keep_marker(session, add_video):
    from app.services.video_delete import delete_video_cascade

    video = add_video(channel=CHANNEL)
    session.add(RetentionKeep(video_id=video.id))
    session.commit()

    delete_video_cascade(session, video, False)

    assert session.exec(select(RetentionKeep)).all() == []
