"""Related lists keep a few places for the viewer's other interests.

Vectors are tiny and hand made (``test_discovery._vec``): Counter-Strike is the
x axis, cooking the third axis, so the two topics do not overlap at all.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.context import current
from app.services import stream_preview
from app.services.discovery import other_interests, tuning
from app.services.discovery.candidates import Candidate
from app.services.discovery.feed import ranked_feed, today_seed
from app.services.discovery.picks import FeedItem, Reason
from tests.test_discovery import (
    _catalog,
    _discovered,
    _embed,
    _vec,
    _watched,
    _yt,
)

STREAM_ID = "csstream001"
CS_URL = "https://www.youtube.com/@cs"


def _cook(angle: float) -> list[float]:
    return _vec(angle, axis=2)


@pytest.fixture
def ai_on(monkeypatch):
    """Embeddings count as available (vectors are written by the tests)."""
    for target in (
        "app.services.discovery.feed.get_embed_provider",
        "app.services.discovery.relevance.get_embed_provider",
        "app.services.ai.provider.get_embed_provider",
        "app.services.stream_related.get_embed_provider",
    ):
        monkeypatch.setattr(target, lambda: object())


def _watch_two_interests(session, add_video, set_watch, user):
    """``user`` watches a lot of Counter-Strike and some cooking."""
    for n in range(5):
        _watched(
            session,
            add_video,
            set_watch,
            user,
            _vec(0.01 * n),
            channel="CS",
            channel_url=CS_URL,
            title=f"CS watched {n}",
            yt_id=f"cswatched{n:02d}",
        )
    for n in range(3):
        _watched(
            session,
            add_video,
            set_watch,
            user,
            _cook(0.01 * n),
            channel="Cook",
            title=f"Cook watched {n}",
            yt_id=f"cookwatch{n:02d}",
        )


@pytest.fixture
def two_interests(session, add_video, set_watch, admin_user):
    _watch_two_interests(session, add_video, set_watch, admin_user)


def _cs_library(session, add_video, count=20):
    """A Counter-Strike video and ``count`` more like it, nearest first."""
    source = add_video(
        title="CS source", channel="CS", channel_url=CS_URL, yt_id="cssource001"
    )
    _embed(session, source, _vec(0.0))
    for n in range(count):
        video = add_video(
            title=f"CS {n}",
            channel="CS",
            channel_url=CS_URL,
            yt_id=f"cslibrary{n:02d}",
        )
        _embed(session, video, _vec(0.002 * (n + 1)))
    return source


def _cook_library(session, add_video, count=6):
    for n in range(count):
        video = add_video(title=f"Cook {n}", channel="Cook", yt_id=f"cooklibra{n:02d}")
        _embed(session, video, _cook(0.002 * n))


def _woven(on_topic: list[str], others: list[str], share: float, size: int) -> str:
    """The pattern ``weave`` lays out: "." on the topic, "O" another interest."""
    out: list[str] = []

    def add(item: str) -> bool:
        if item in out or len(out) >= size:
            return False
        out.append(item)
        return True

    other_interests.weave(on_topic, others, add, share)
    return "".join("O" if item.isupper() else "." for item in out)


def test_weave_leads_with_the_topic_and_mixes_in_more_further_down():
    on_topic = [f"t{n}" for n in range(60)]
    others = [f"O{n}" for n in range(60)]
    assert _woven(on_topic, others, 0.0, 24) == "." * 24
    for share in (0.2, 0.35, 0.5):
        pattern = _woven(on_topic, others, share, 24)
        assert pattern.startswith("." * other_interests.LEAD)
        # About the share overall, and more in the second half than the first.
        assert abs(pattern.count("O") - share * 24) <= 2
        assert pattern[12:].count("O") > pattern[:12].count("O")
    # A bigger share never gives fewer places.
    counts = [_woven(on_topic, others, s / 10, 24).count("O") for s in range(6)]
    assert counts == sorted(counts)


def test_weave_counts_only_the_items_it_took():
    out: list[str] = []

    def add(item: str) -> bool:
        if item in out or len(out) >= 9:
            return False
        out.append(item)
        return True

    other_interests.weave(
        ["a", "b", "b", "c", "d", "e", "f", "g", "h"], ["c", "X", "Y", "Z"], add, 0.5
    )
    # The second "b" is a duplicate and does not count as a place; "c" is
    # already listed, so the next other pick takes its turn.
    assert out == ["a", "b", "c", "d", "X", "e", "f", "Y", "g"]


def _item(channel: str, topic: int | None) -> FeedItem:
    return FeedItem(
        candidate=Candidate(
            key=f"yt:{channel}",
            pool="catalog",
            title=channel,
            channel=channel,
            channel_url="",
        ),
        bucket="similar",
        score=1.0,
        reason=Reason("similar", ""),
        topic=topic,
    )


def test_interests_take_turns_and_nearby_ones_lead():
    # Feed order: three cooking picks, then two of another shooter (nearby to
    # the playing video), then a channel the feed has no interest for.
    items = [
        _item("Cook A", 1),
        _item("Cook B", 1),
        _item("Cook C", 1),
        _item("Shooter A", 2),
        _item("Shooter B", 2),
        _item("Loner", None),
    ]
    nearby = [False, False, False, True, False, False]
    order = [c.channel for c in other_interests._order(items, nearby)]
    assert order == ["Shooter A", "Cook A", "Loner", "Cook B", "Shooter B", "Cook C"]


def test_a_stream_lists_mostly_its_topic_and_some_other_interests(
    client, session, admin_user, two_interests, ai_on, monkeypatch
):
    monkeypatch.setattr(
        stream_preview,
        "extract_stream_preview_meta",
        lambda url: {
            "id": STREAM_ID,
            "title": "CS major final",
            "channel": "CS",
            "channel_url": CS_URL,
            "source_url": _yt(STREAM_ID),
        },
    )
    _catalog(
        session,
        "CS",
        [(STREAM_ID, "CS major final", 0, _vec(0.0))]
        + [
            (f"csupload{n:03d}", f"CS upload {n}", n + 1, _vec(0.002 * (n + 1)))
            for n in range(30)
        ],
    )
    _catalog(
        session,
        "Cook",
        [
            (f"cookuploa{n:02d}", f"Cook upload {n}", n + 1, _cook(0.002 * n))
            for n in range(10)
        ],
    )

    res = client.get("/api/preview/related", params={"url": _yt(STREAM_ID)})
    assert res.status_code == 200, res.text
    channels = [i["channel"] for i in res.json()["items"]]
    assert len(channels) == 24
    # The lead is the stream's topic; the viewer's other interest comes in
    # after it, more often further down the list, and never twice in a row.
    lead = other_interests.LEAD
    assert channels[:lead] == ["CS"] * lead
    pattern = "".join("O" if c == "Cook" else "." for c in channels)
    assert 4 <= pattern.count("O") <= 8, pattern
    assert pattern[12:].count("O") > pattern[:12].count("O"), pattern
    assert "OO" not in pattern
    assert STREAM_ID not in [i["id"] for i in res.json()["items"]]


def test_a_library_video_lists_some_other_interests_on_every_page(
    client, session, add_video, two_interests, ai_on
):
    # A crowded topic: other interests get Balanced's full share.
    source = _cs_library(session, add_video, count=60)
    _cook_library(session, add_video, count=24)

    def page(offset: int, limit: int = 8) -> list[dict]:
        res = client.get(
            f"/api/videos/{source.id}/related",
            params={"limit": limit, "offset": offset},
        )
        assert res.status_code == 200, res.text
        return res.json()

    first, second, whole = page(0), page(8), page(0, 16)
    assert [v["id"] for v in first + second] == [v["id"] for v in whole]
    assert len({v["id"] for v in whole}) == 16
    channels = [v["channel"] for v in whole]
    assert channels[: other_interests.LEAD] == ["CS"] * other_interests.LEAD
    assert "Cook" in channels[:8]
    assert "Cook" in channels[8:]


def test_related_lists_stay_on_topic_without_a_watch_history(
    client, session, add_video, ai_on
):
    # Crowded enough for other interests, but there are none to show.
    source = _cs_library(session, add_video, count=60)
    _cook_library(session, add_video, count=6)

    res = client.get(f"/api/videos/{source.id}/related", params={"limit": 24})
    assert [v["channel"] for v in res.json()] == ["CS"] * 24


def _others(session, user, **kwargs) -> other_interests.Others:
    viewer = other_interests.Viewer(user.id, current().discovery)
    return other_interests.other_interest_picks(session, viewer, **kwargs)


def _picks(session, user, **kwargs) -> list[str]:
    return [c.channel for c in _others(session, user, **kwargs).picks]


def test_another_interest_is_told_by_closeness_not_by_channel(
    session, admin_user, two_interests, ai_on
):
    # New uploads of the playing video's channel, another channel on its topic,
    # one on another topic, and a found video that has no vector yet (it could
    # be about anything).
    _catalog(
        session,
        "CS",
        [(f"csupload{n:03d}", f"CS upload {n}", n + 1, _vec(0.02)) for n in range(3)],
    )
    _catalog(
        session,
        "Rival",
        [(f"rivalcs{n:04d}", f"Rival CS {n}", n + 1, _vec(0.03)) for n in range(3)],
    )
    _catalog(
        session,
        "Cook",
        [
            (f"cookuploa{n:02d}", f"Cook upload {n}", n + 1, _cook(0.0))
            for n in range(3)
        ],
    )
    _discovered(session, admin_user, "mysteryvid1", "Who knows", "Mystery")
    # Far from everything watched: the bottom of the feed's own scale.
    for n in range(2):
        _discovered(
            session, admin_user, f"farawayvi{n:02d}", "Far", "Nobody", _vec(0.0, axis=1)
        )
    feed = ranked_feed(session, current().discovery, admin_user.id, today_seed())
    in_feed = {i.candidate.channel for i in feed.items if i.eligible}
    assert {"CS", "Rival", "Cook", "Mystery"} <= in_feed

    picks = _picks(session, admin_user, vector=_vec(0.0), channel="CS")
    assert set(picks) == {"Cook"}
    # A vector that cannot be compared gives no picks rather than wrong ones.
    assert _picks(session, admin_user, vector=[0.0] * 4, channel="CS") == []
    assert _picks(session, admin_user, vector=[float("nan")] * 4, channel="CS") == []

    # Without embeddings the playing video's channel is all there is to go by.
    by_channel = _picks(session, admin_user, vector=None, channel="CS")
    assert {"Rival", "Cook", "Mystery"} <= set(by_channel)
    assert "CS" not in by_channel
    library_only = _picks(
        session, admin_user, vector=None, channel="CS", library_only=True
    )
    assert library_only == []


def test_a_restricted_member_still_gets_full_pages(
    client, member_client, member_user, session, add_video, set_watch, ai_on
):
    _watch_two_interests(session, add_video, set_watch, member_user)
    source = _cs_library(session, add_video, count=60)
    _cook_library(session, add_video, count=24)

    def related() -> list[str]:
        res = member_client.get(
            f"/api/videos/{source.id}/related", params={"limit": 24}
        )
        assert res.status_code == 200, res.text
        return [v["channel"] for v in res.json()]

    assert "Cook" in related()
    res = client.put(
        f"/api/users/{member_user.id}/allowed-channels",
        json={"channels": [{"url": CS_URL, "name": "CS"}]},
    )
    assert res.status_code == 200, res.text
    # Cooking is not theirs to see, and its places are not left empty either.
    assert related() == ["CS"] * 24


def test_disallowed_related_videos_are_dropped_before_the_mix(
    session, add_video, set_watch, member_user, ai_on
):
    """The endpoint drops a restricted member's other channels after the mix;
    dropping them first keeps the lead on topic and the picks apart."""
    from app.services import library
    from app.services.parental import AllowedChannel, AllowList

    _watch_two_interests(session, add_video, set_watch, member_user)
    _cs_library(session, add_video, count=60)
    # A clip channel's video, whose nearest related videos are a channel this
    # member may not watch (no channel is nudged up as the video's own).
    clips = "https://www.youtube.com/@clips"
    source = add_video(title="Clip", channel="Clips", channel_url=clips)
    _embed(session, source, _vec(0.0))
    for n in range(6):
        video = add_video(
            title=f"Banned {n}", channel="Banned", yt_id=f"bannedvi{n:03d}"
        )
        _embed(session, video, _vec(0.0001 * (n + 1)))
    _cook_library(session, add_video, count=24)
    allowed = AllowList(
        (
            AllowedChannel(CS_URL, "CS"),
            AllowedChannel(clips, "Clips"),
            AllowedChannel(None, "Cook"),
        )
    )
    viewer = other_interests.Viewer(member_user.id, current().discovery, allowed)
    rows = library.related_videos(
        session, source.id, limit=24, user_id=member_user.id, viewer=viewer
    )
    channels = [v.channel for v in rows]
    assert "Banned" not in channels
    assert channels[: other_interests.LEAD] == ["CS"] * other_interests.LEAD
    pattern = "".join("O" if c == "Cook" else "." for c in channels)
    assert "OO" not in pattern and "O" in pattern, pattern


def test_pages_agree_when_a_pick_is_already_in_the_list(
    client, session, add_video, set_watch, admin_user
):
    # Without AI a short channel's list is filled with other channels' videos,
    # the same ones the other-interest picks come from.
    source = add_video(title="CS 0", channel="CS", yt_id="cslibrary00")
    for n in range(1, 4):
        add_video(title=f"CS {n}", channel="CS", yt_id=f"cslibrary{n:02d}")
    for n in range(17):
        video = add_video(
            title=f"Cook {n}", channel="Cook", yt_id=f"cooklibra{n:02d}", tags=["food"]
        )
        if n < 3:
            set_watch(admin_user, video, 0, datetime.now(UTC) - timedelta(days=1))
    for n in range(6):
        add_video(title=f"Misc {n}", channel=f"Misc {n}", yt_id=f"misclibra{n:02d}")

    def ids(limit: int, offset: int) -> list[int]:
        res = client.get(
            f"/api/videos/{source.id}/related",
            params={"limit": limit, "offset": offset},
        )
        assert res.status_code == 200, res.text
        return [v["id"] for v in res.json()]

    whole = ids(24, 0)
    assert len(set(whole)) == 24
    assert ids(8, 0) + ids(8, 8) + ids(8, 16) == whole


def test_a_crowded_topic_gives_other_interests_more_places(
    session, add_video, admin_user, two_interests, ai_on
):
    _cook_library(session, add_video)
    # The five Counter-Strike watches and the playing video: a thin topic,
    # which runs out by itself, so nothing is mixed in.
    thin = _others(session, admin_user, vector=_vec(0.0), channel="CS")
    assert thin.share == 0
    _cs_library(session, add_video, count=60)
    crowded = _others(session, admin_user, vector=_vec(0.0), channel="CS")
    assert crowded.share == pytest.approx(tuning.DEFAULTS.related_other_share)
    assert {c.channel for c in crowded.picks} == {"Cook"}


def test_the_viewers_algorithm_sets_how_far_a_list_leaves_the_topic(
    client, session, add_video, admin_user, two_interests, ai_on
):
    source = _cs_library(session, add_video, count=60)
    _cook_library(session, add_video, count=24)

    def cooking_places(preset: str) -> int:
        tuning.save(session, admin_user.id, tuning.Selection(active=preset))
        res = client.get(f"/api/videos/{source.id}/related", params={"limit": 24})
        assert res.status_code == 200, res.text
        return [v["channel"] for v in res.json()].count("Cook")

    familiar, balanced, explorer = (
        cooking_places(p) for p in ("familiar", "balanced", "explorer")
    )
    assert 0 < familiar < balanced < explorer


def test_a_nearby_interest_comes_before_an_unrelated_one(
    session, add_video, set_watch, admin_user, two_interests, ai_on
):
    _cs_library(session, add_video)
    # The viewer also watches another shooter: not Counter-Strike, but far
    # closer to it than cooking. Cooking is first in their feed.
    for n in range(2):
        _watched(
            session,
            add_video,
            set_watch,
            admin_user,
            _vec(1.2),
            channel="Shooter",
            title=f"Shooter watched {n}",
            yt_id=f"shootwatc{n:02d}",
            days_ago=3,
        )
    for name, vec in (("Cook", _cook(0.0)), ("Shooter", _vec(1.2))):
        _catalog(
            session,
            name,
            [(f"{name.lower()}up{n:04d}", f"{name} {n}", n + 1, vec) for n in range(3)],
        )
    picks = _picks(session, admin_user, vector=_vec(0.0), channel="CS")
    assert set(picks) == {"Shooter", "Cook"}
    # Each interest takes a turn, the nearby one first.
    assert picks[:2] == ["Shooter", "Cook"]
