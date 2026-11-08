"""Subscribing to new channels from downloads, the download card's prompt, the
manage_subscriptions permission and turning Ask on when subscribing."""

from __future__ import annotations

import pytest
from sqlmodel import Session, select

from app.models import ChannelFollow, DownloadJob, JobStatus, KbChannel, User
from app.services import app_settings, follows
from app.services.auth import accounts
from app.services.knowledge import channels as kb_channels
from app.services.knowledge import listing

CHANNEL = "https://www.youtube.com/@dlchan"
NORMAL = "https://youtube.com/@dlchan"


def _setting(mode: str, members: bool = True) -> None:
    app_settings.save(
        {"new_channel_subscribe": mode, "new_channel_subscribe_members": members}
    )


def _finished_download(session: Session, user_id: int, add_video) -> int:
    video = add_video(channel="Dl Chan", channel_url=CHANNEL)
    job = DownloadJob(
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        status=JobStatus.completed,
        video_id=video.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    assert job.id is not None and video.id is not None
    follows.record_requester(session, job.id, user_id)
    session.commit()
    follows.follow_from_download(job.id, video.id)
    return job.id


def _followed(engine, user_id: int) -> list[ChannelFollow]:
    with Session(engine) as s:
        return list(
            s.exec(select(ChannelFollow).where(ChannelFollow.user_id == user_id)).all()
        )


def _prompt(c, job_id: int):
    [job] = [j for j in c.get("/api/downloads").json() if j["id"] == job_id]
    return job["subscribe_prompt"]


# --- the setting ---------------------------------------------------------------


def test_setting_defaults_and_round_trips(client, member_client):
    body = client.get("/api/settings").json()
    assert body["new_channel_subscribe"] == "always"
    assert body["new_channel_subscribe_members"] is True
    resp = client.patch(
        "/api/settings",
        json={"new_channel_subscribe": "ask", "new_channel_subscribe_members": False},
    )
    assert resp.status_code == 200
    # Members read it (the download card depends on it) but may not change it.
    body = member_client.get("/api/settings").json()
    assert body["new_channel_subscribe"] == "ask"
    assert body["new_channel_subscribe_members"] is False
    assert (
        member_client.patch(
            "/api/settings", json={"new_channel_subscribe": "always"}
        ).status_code
        == 403
    )
    assert (
        client.patch("/api/settings", json={"new_channel_subscribe": "maybe"})
    ).status_code == 422


# --- what a finished download does ---------------------------------------------


def test_always_subscribes_without_a_prompt(
    client, session, admin_user, add_video, init_db
):
    job_id = _finished_download(session, admin_user.id, add_video)
    [row] = _followed(init_db["engine"], admin_user.id)
    assert row.followed and row.channel_url == NORMAL
    assert _prompt(client, job_id) is None


def test_ask_prompts_the_requester_until_they_answer(
    client, member_client, session, admin_user, add_video, init_db
):
    _setting("ask")
    job_id = _finished_download(session, admin_user.id, add_video)
    assert _followed(init_db["engine"], admin_user.id) == []
    assert _prompt(client, job_id) == {"channel_url": NORMAL, "channel_name": "Dl Chan"}
    # Only the one who queued it is asked.
    assert _prompt(member_client, job_id) is None
    # Subscribing answers it...
    follows.follow(session, admin_user.id, NORMAL, "Dl Chan")
    assert _prompt(client, job_id) is None
    # ... and so does saying no (a tombstone).
    follows.unfollow(session, admin_user.id, NORMAL)
    assert _prompt(client, job_id) is None


def test_never_neither_subscribes_nor_prompts(
    client, session, admin_user, add_video, init_db
):
    _setting("never")
    job_id = _finished_download(session, admin_user.id, add_video)
    assert _followed(init_db["engine"], admin_user.id) == []
    assert _prompt(client, job_id) is None


@pytest.mark.parametrize("mode", ["always", "ask"])
def test_members_left_out_get_neither(
    mode, member_client, session, member_user, add_video, init_db
):
    _setting(mode, members=False)
    job_id = _finished_download(session, member_user.id, add_video)
    assert _followed(init_db["engine"], member_user.id) == []
    assert _prompt(member_client, job_id) is None


def test_members_included_are_treated_like_the_admin(
    member_client, session, member_user, add_video
):
    _setting("ask", members=True)
    job_id = _finished_download(session, member_user.id, add_video)
    assert _prompt(member_client, job_id)["channel_url"] == NORMAL


def _revoke(engine, user, permission: str) -> None:
    with Session(engine) as s:
        row = s.get(User, user.id)
        assert row is not None
        granted = accounts.effective_permissions(row) - {permission}
        accounts.update_user(s, user.id, granted=granted)


def test_without_manage_subscriptions_nothing_subscribes(
    member_client, session, member_user, add_video, init_db
):
    _revoke(init_db["engine"], member_user, "manage_subscriptions")
    job_id = _finished_download(session, member_user.id, add_video)
    assert _followed(init_db["engine"], member_user.id) == []
    _setting("ask")
    assert _prompt(member_client, job_id) is None
    assert (
        member_client.put("/api/follows", json={"channel_url": CHANNEL}).status_code
        == 403
    )
    assert (
        member_client.delete("/api/follows", params={"channel_url": CHANNEL})
    ).status_code == 403
    # Takeout may still make playlists, but not subscribe.
    resp = member_client.post(
        "/api/takeout/apply",
        json={
            "subscriptions": [{"channel_url": CHANNEL, "channel_name": "Dl Chan"}],
            "playlists": [],
        },
    )
    assert resp.status_code == 403
    assert _followed(init_db["engine"], member_user.id) == []


# --- turning Ask on when subscribing --------------------------------------------


@pytest.fixture
def channel_size(monkeypatch):
    """The upload count the YouTube lookup reports; no network."""
    size = {"count": 120}
    seen: list[str] = []

    def fake(url: str) -> listing.Preview:
        seen.append(url)
        return listing.Preview(
            channel_name="Dl Chan",
            channel_url=url,
            video_count=size["count"],
            has_streams=False,
        )

    monkeypatch.setattr(listing, "preview", fake)
    monkeypatch.setattr("app.api.follows.fetch_live_page", lambda *a, **k: "")
    size["seen"] = seen  # type: ignore[assignment]  # test bookkeeping
    return size


def _kb(engine) -> list[KbChannel]:
    with Session(engine) as s:
        return list(s.exec(select(KbChannel)).all())


def _subscribe(c) -> None:
    assert c.put("/api/follows", json={"channel_url": CHANNEL}).status_code == 200


def test_small_channel_is_indexed_on_subscribe(client, channel_size, init_db):
    _subscribe(client)
    body = client.post("/api/follows/ask-index", json={"channel_url": CHANNEL}).json()
    assert body["indexed"] is True and body["large"] is False
    assert body["video_count"] == 120
    [kb] = _kb(init_db["engine"])
    assert kb.channel_url == NORMAL and kb.include_streams is False
    # Asking again changes nothing and says it was on already.
    again = client.post("/api/follows/ask-index", json={"channel_url": CHANNEL})
    assert again.json()["already"] is True
    assert len(_kb(init_db["engine"])) == 1


def test_large_channel_waits_for_a_confirm(client, channel_size, init_db):
    channel_size["count"] = follows.ASK_INDEX_AUTO_MAX + 1
    _subscribe(client)
    body = client.post("/api/follows/ask-index", json={"channel_url": CHANNEL}).json()
    assert body == {
        "channel_url": NORMAL,
        "channel_name": "Dl Chan",
        "video_count": follows.ASK_INDEX_AUTO_MAX + 1,
        "indexed": False,
        "already": False,
        "large": True,
    }
    assert _kb(init_db["engine"]) == []
    confirmed = client.post(
        "/api/follows/ask-index",
        json={"channel_url": CHANNEL, "confirm_large": True},
    )
    assert confirmed.json()["indexed"] is True
    assert len(_kb(init_db["engine"])) == 1


@pytest.mark.parametrize(("more", "indexed"), [(True, False), (False, True)])
def test_unknown_size_is_counted_by_looking_past_the_limit(
    more, indexed, client, channel_size, monkeypatch, init_db
):
    """YouTube often reports no count for a channel: whether there is an upload
    past the limit decides instead."""
    channel_size["count"] = None
    asked: list[int] = []

    def fake(url: str, n: int) -> bool:
        asked.append(n)
        return more

    monkeypatch.setattr(listing, "has_more_uploads_than", fake)
    _subscribe(client)
    body = client.post("/api/follows/ask-index", json={"channel_url": CHANNEL}).json()
    assert asked == [follows.ASK_INDEX_AUTO_MAX]
    assert body["indexed"] is indexed and body["large"] is (not indexed)
    assert len(_kb(init_db["engine"])) == (1 if indexed else 0)


def test_turned_on_meanwhile_counts_as_already(client, monkeypatch, init_db):
    """Two subscribers at once: the second finds it on, not an error."""
    monkeypatch.setattr("app.api.follows.fetch_live_page", lambda *a, **k: "")

    def racing_preview(url: str) -> listing.Preview:
        with Session(init_db["engine"]) as s:
            s.add(KbChannel(channel_url=NORMAL, channel_name="Dl Chan"))
            s.commit()
        return listing.Preview(
            channel_name="Dl Chan", channel_url=url, video_count=10, has_streams=False
        )

    monkeypatch.setattr(listing, "preview", racing_preview)
    # Both look-ups before the insert miss it, as in a real race; add() then
    # finds it.
    real_find = kb_channels._find
    calls = {"n": 0}

    def late_find(session, url):
        calls["n"] += 1
        return None if calls["n"] <= 2 else real_find(session, url)

    monkeypatch.setattr(kb_channels, "_find", late_find)
    _subscribe(client)
    resp = client.post("/api/follows/ask-index", json={"channel_url": CHANNEL})
    assert resp.status_code == 200
    assert resp.json()["already"] is True and resp.json()["indexed"] is True
    assert len(_kb(init_db["engine"])) == 1


def test_only_subscribers_index(client, channel_size, init_db):
    resp = client.post("/api/follows/ask-index", json={"channel_url": CHANNEL})
    assert resp.status_code == 409
    assert resp.json()["code"] == "not_followed"
    assert channel_size["seen"] == []


def test_member_indexes_small_channels_while_included(
    member_client, channel_size, init_db
):
    _subscribe(member_client)
    resp = member_client.post("/api/follows/ask-index", json={"channel_url": CHANNEL})
    assert resp.status_code == 200 and resp.json()["indexed"] is True


def test_member_may_not_confirm_a_large_channel(member_client, channel_size, init_db):
    channel_size["count"] = 5000
    _subscribe(member_client)
    resp = member_client.post(
        "/api/follows/ask-index",
        json={"channel_url": CHANNEL, "confirm_large": True},
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "channel_too_large"
    assert _kb(init_db["engine"]) == []


@pytest.mark.parametrize(("mode", "members"), [("never", True), ("ask", False)])
def test_member_left_out_may_not_index(
    mode, members, member_client, channel_size, init_db
):
    _subscribe(member_client)
    _setting(mode, members)
    resp = member_client.post("/api/follows/ask-index", json={"channel_url": CHANNEL})
    assert resp.status_code == 403
    assert channel_size["seen"] == []


def test_never_also_skips_the_administrators_library_seed(
    session, admin_user, add_video
):
    add_video(channel="One", channel_url="https://www.youtube.com/@one")
    _setting("never")
    assert follows.seed_administrators() == 0
    assert follows.list_follows(session, admin_user.id) == []


# --- a download that subscribes also turns Ask on ------------------------------


def test_auto_subscribe_indexes_a_small_channel(
    session, admin_user, add_video, channel_size, init_db
):
    _finished_download(session, admin_user.id, add_video)
    [kb] = _kb(init_db["engine"])
    assert kb.channel_url == NORMAL and kb.added_by == admin_user.id


def test_auto_subscribe_leaves_a_big_channel_alone(
    session, admin_user, add_video, channel_size, init_db
):
    channel_size["count"] = follows.ASK_INDEX_AUTO_MAX + 1
    _finished_download(session, admin_user.id, add_video)
    assert _followed(init_db["engine"], admin_user.id)[0].followed
    assert _kb(init_db["engine"]) == []


@pytest.mark.parametrize("mode", ["ask", "never"])
def test_no_auto_subscribe_no_index(
    mode, session, admin_user, add_video, channel_size, init_db
):
    _setting(mode)
    _finished_download(session, admin_user.id, add_video)
    assert _kb(init_db["engine"]) == []
    assert channel_size["seen"] == []


def test_included_member_auto_subscribe_indexes_too(
    session, member_user, add_video, channel_size, init_db
):
    _finished_download(session, member_user.id, add_video)
    assert len(_kb(init_db["engine"])) == 1


def test_a_failed_lookup_keeps_the_subscription(
    session, admin_user, add_video, monkeypatch, init_db
):
    def broken(url: str) -> listing.Preview:
        raise RuntimeError("YouTube is down")

    monkeypatch.setattr(listing, "preview", broken)
    _finished_download(session, admin_user.id, add_video)
    assert _followed(init_db["engine"], admin_user.id)[0].followed
    assert _kb(init_db["engine"]) == []
