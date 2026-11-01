"""Recommended+ topics typed in by hand: interests and blocks, with expiry."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlmodel import select

from tests.test_discovery import _catalog, _discovered, _history, _items, _vec
from tests.test_discovery import ai_on as _ai_on
from tests.test_discovery import youtube as _youtube

ai_on = _ai_on
youtube = _youtube


def _iso(**kw) -> str:
    return (datetime.now(UTC) + timedelta(**kw)).isoformat()


def _add(client, **body):
    resp = client.post("/api/discover/topics", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_topics_are_added_listed_changed_and_deleted(client):
    interest = _add(client, kind="interest", text="  Europe   travel vlogs ")
    assert interest["text"] == "Europe travel vlogs"
    assert interest["strength"] == "normal" and interest["active"] is True
    block = _add(client, kind="block", text="crypto", match="similar")
    listed = client.get("/api/discover/topics").json()["items"]
    assert [t["id"] for t in listed] == [interest["id"], block["id"]]

    resp = client.patch(
        f"/api/discover/topics/{interest['id']}",
        json={"strength": "high", "expires_at": _iso(days=14)},
    )
    assert resp.status_code == 200 and resp.json()["strength"] == "high"
    assert resp.json()["expires_at"] is not None
    # Null: never expires.
    resp = client.patch(
        f"/api/discover/topics/{interest['id']}", json={"expires_at": None}
    )
    assert resp.json()["expires_at"] is None
    assert client.delete(f"/api/discover/topics/{block['id']}").status_code == 200
    assert len(client.get("/api/discover/topics").json()["items"]) == 1


def test_topics_are_validated(client, member_client):
    bad = [
        {"kind": "interest", "text": "!!!"},
        {"kind": "interest", "text": "x" * 81},
        {"kind": "mood", "text": "cats"},
        {"kind": "block", "text": "cats", "match": "fuzzy"},
        {"kind": "interest", "text": "cats", "expires_at": "2030-01-01T00:00:00"},
    ]
    for body in bad:
        assert client.post("/api/discover/topics", json=body).status_code == 422, body
    resp = client.post(
        "/api/discover/topics",
        json={"kind": "interest", "text": "cats", "expires_at": _iso(days=-1)},
    )
    assert resp.status_code == 400 and resp.json()["code"] == "expired"
    # Someone else's topic is not there.
    mine = _add(client, kind="interest", text="cats")
    assert (
        member_client.patch(
            f"/api/discover/topics/{mine['id']}", json={"strength": "low"}
        ).status_code
        == 404
    )
    assert member_client.delete(f"/api/discover/topics/{mine['id']}").status_code == 404
    assert member_client.get("/api/discover/topics").json()["items"] == []


def test_ten_interests_can_be_on_at_once(client, session, admin_user):
    from app.models import RecTopic

    for n in range(10):
        _add(client, kind="interest", text=f"topic {n}")
    resp = client.post("/api/discover/topics", json={"kind": "interest", "text": "x"})
    assert resp.status_code == 409 and resp.json()["code"] == "too_many_topics"
    # An expired one does not count, and turning it on again checks the limit.
    row = session.get(RecTopic, 1)
    assert row is not None
    row.expires_at = datetime.now(UTC) - timedelta(days=1)
    session.add(row)
    session.commit()
    listed = client.get("/api/discover/topics").json()["items"]
    assert [t["active"] for t in listed].count(False) == 1
    _add(client, kind="interest", text="one more")
    resp = client.patch("/api/discover/topics/1", json={"expires_at": None})
    assert resp.status_code == 409


def test_a_word_block_leaves_videos_out_and_says_how_many(client, session, admin_user):
    _discovered(session, admin_user, "blockme0001", "Crypto news today", "Coins")
    _discovered(session, admin_user, "blockme0002", "Why CRYPTO crashed", "Other")
    _discovered(session, admin_user, "keepme00001", "Cryptography basics", "Math")
    block = _add(client, kind="block", text="crypto")
    body = client.get("/api/discover/feed", params={"limit": 60}).json()
    keys = {i["key"] for i in body["items"]}
    # Whole words only.
    assert "keepme00001" in keys
    assert not {"blockme0001", "blockme0002"} & keys
    assert body["blocked"] == [{"topic_id": block["id"], "count": 2}]


def test_word_blocks_apply_to_recommended_too(client, session, admin_user):
    _catalog(
        session,
        "Mixed",
        [
            ("mixedup0001", "Crypto explained", 3, None),
            ("mixedup0002", "Bread", 3, None),
        ],
    )
    _add(client, kind="block", text="crypto")
    body = client.get("/api/ai/recommendations", params={"include_streams": True})
    titles = [
        (i["stream"] or i["video"])["title"]
        for s in body.json()["sections"]
        for i in s["items"]
    ]
    assert "Bread" in titles and "Crypto explained" not in titles


def test_an_interest_gets_its_own_picks_until_it_expires(client, session, admin_user):
    _discovered(session, admin_user, "travelvid01", "Europe travel vlogs: Lisbon", "A")
    _discovered(session, admin_user, "othervid001", "Something else", "B")
    topic = _add(client, kind="interest", text="Europe travel vlogs")
    body = client.get("/api/discover/feed", params={"limit": 60}).json()
    by_key = {i["key"]: i for i in body["items"]}
    pick = by_key["travelvid01"]
    assert pick["reason"]["kind"] == "interest"
    assert pick["reason"]["text"] == "For your interest: Europe travel vlogs"
    assert pick["why"]["bucket"] == "interest"
    mix = {m["bucket"]: m["target"] for m in body["mix"]}
    assert 0 < mix["interest"] <= 0.35
    assert abs(sum(mix.values()) - 1) < 1e-6
    assert by_key["othervid001"]["why"]["bucket"] != "interest"

    from app.models import RecTopic

    row = session.get(RecTopic, topic["id"])
    assert row is not None
    row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    session.add(row)
    session.commit()
    client.put("/api/discover/tuning", json={"active": "balanced"})  # re-rank
    by_key = {i["key"]: i for i in _items(client)}
    assert by_key["travelvid01"]["reason"]["kind"] != "interest"


def test_a_similar_block_leaves_out_what_is_close_in_meaning(
    client, session, admin_user, monkeypatch, ai_on
):
    from app.services.discovery import topics

    monkeypatch.setattr(topics, "get_embed_provider", lambda: object())
    monkeypatch.setattr(topics, "resolve_embed_model", lambda _p: "m")
    monkeypatch.setattr(topics, "embed_query", lambda _text: _vec(0.0, axis=2))
    # One video about the blocked topic, many that are not.
    _discovered(session, admin_user, "closetotopc", "Tokens", "C", _vec(0.01, axis=2))
    for n in range(12):
        _discovered(
            session, admin_user, f"farfrom{n:04d}", f"Far {n}", f"F{n}", _vec(0.1 * n)
        )
    assert "closetotopc" in {i["key"] for i in _items(client)}
    _add(client, kind="block", text="crypto", match="similar")
    keys = {i["key"] for i in _items(client)}
    assert "closetotopc" not in keys
    assert len([k for k in keys if k.startswith("farfrom")]) == 12


def test_typed_interests_are_searched_first_and_blocks_filter_results(
    client, session, add_video, set_watch, admin_user, youtube, tmp_dirs
):
    from app.models import DiscoveryVideo
    from app.services.discovery import gather

    calls, answers = youtube
    _history(session, add_video, set_watch, admin_user)
    _add(client, kind="interest", text="kayak camping")
    _add(client, kind="block", text="sponsored")
    answers["kayak camping"] = [
        {
            "id": "kayakvid001",
            "url": "https://www.youtube.com/watch?v=kayakvid001",
            "title": "Kayak camping trip",
            "channel": "Paddle",
            "channel_url": "https://www.youtube.com/@paddle",
        },
        {
            "id": "kayakvid002",
            "url": "https://www.youtube.com/watch?v=kayakvid002",
            "title": "Sponsored kayak review",
            "channel": "Ads",
            "channel_url": "https://www.youtube.com/@ads",
        },
    ]
    runtime = tmp_dirs["ctx"].discovery
    gather.gather_for(session, runtime, admin_user.id)
    searches = [q for kind, q in calls if kind == "search"]
    assert searches[0] == "kayak camping"
    assert len(searches) <= gather.SEARCHES_PER_RUN
    stored = {r.yt_id for r in session.exec(select(DiscoveryVideo))}
    assert "kayakvid001" in stored and "kayakvid002" not in stored
    # Not again the same day.
    calls.clear()
    gather.gather_for(session, runtime, admin_user.id)
    assert "kayak camping" not in [q for kind, q in calls if kind == "search"]
