"""Related lists keep a few places for the viewer's other interests.

Vectors are tiny and hand made (``test_discovery._vec``): Counter-Strike is the
x axis, cooking the third axis, so the two topics do not overlap at all.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.context import current
from app.services import stream_preview
from app.services.discovery import other_interests
from app.services.discovery.feed import ranked_feed, today_seed
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


def test_weave_gives_every_fourth_place_to_another_interest():
    out: list[str] = []

    def add(item: str) -> bool:
        if item in out or len(out) >= 9:
            return False
        out.append(item)
        return True

    other_interests.weave(
        ["a", "b", "b", "c", "d", "e", "f", "g", "h"], ["c", "X", "Y", "Z"], add
    )
    # The second "b" is a duplicate and does not count as a place; "c" is
    # already listed, so the next other pick takes its turn.
    assert out == ["a", "b", "c", "X", "d", "e", "f", "Y", "g"]


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
    # Three on the stream's topic, then one of the viewer's other interests.
    assert channels[:8] == ["CS", "CS", "CS", "Cook", "CS", "CS", "CS", "Cook"]
    assert channels.count("Cook") == 6
    assert STREAM_ID not in [i["id"] for i in res.json()["items"]]


def test_a_library_video_lists_some_other_interests_on_every_page(
    client, session, add_video, two_interests, ai_on
):
    source = _cs_library(session, add_video)
    _cook_library(session, add_video)

    def page(offset: int) -> list[dict]:
        res = client.get(
            f"/api/videos/{source.id}/related", params={"limit": 8, "offset": offset}
        )
        assert res.status_code == 200, res.text
        return res.json()

    first, second = page(0), page(8)
    pattern = ["CS", "CS", "CS", "Cook", "CS", "CS", "CS", "Cook"]
    assert [v["channel"] for v in first] == pattern
    assert [v["channel"] for v in second] == pattern
    assert len({v["id"] for v in first + second}) == 16


def test_related_lists_stay_on_topic_without_a_watch_history(
    client, session, add_video, ai_on
):
    source = _cs_library(session, add_video, count=8)
    _cook_library(session, add_video, count=1)

    res = client.get(f"/api/videos/{source.id}/related", params={"limit": 8})
    assert [v["channel"] for v in res.json()] == ["CS"] * 8


def _picks(session, user, **kwargs) -> list[str]:
    viewer = other_interests.Viewer(user.id, current().discovery)
    return [
        c.channel
        for c in other_interests.other_interest_picks(session, viewer, **kwargs)
    ]


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
    source = _cs_library(session, add_video)
    _cook_library(session, add_video)
    res = client.put(
        f"/api/users/{member_user.id}/allowed-channels",
        json={"channels": [{"url": CS_URL, "name": "CS"}]},
    )
    assert res.status_code == 200, res.text

    related = member_client.get(f"/api/videos/{source.id}/related", params={"limit": 8})
    # Cooking is not theirs to see, and its places are not left empty either.
    assert [v["channel"] for v in related.json()] == ["CS"] * 8


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
