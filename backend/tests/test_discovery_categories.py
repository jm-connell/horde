"""Recommended's personal categories: stored interests and what each shows.

Vectors are tiny and hand made (``_vec(a)`` is a unit vector at angle ``a`` in
the plane of two axes), so closeness is plain from the angles.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest
from sqlmodel import select

from app.models import RecCategory
from app.services.ai import embeddings
from app.services.discovery import category_feed, category_store
from app.services.discovery.candidates import Candidate
from app.services.discovery.history import Watch
from app.services.discovery.interests import Interest
from app.services.discovery.picks import Feed
from app.services.discovery.tuning import DEFAULTS, PRESETS

NOW = datetime(2026, 11, 26, tzinfo=UTC)


def _vec(angle: float, axis: int = 0) -> list[float]:
    out = [0.0] * 6
    out[axis] = math.cos(angle)
    out[axis + 1] = math.sin(angle)
    return out


def _group(
    angle: float, axis: int = 0, *, name=None, named_by="keywords", era="recent"
):
    watch = Watch(
        key="w",
        yt_id="seedvideo01",
        video_id=None,
        title="Seed",
        channel="Ch",
        channel_url="",
        watched_at=NOW,
        engagement=1.0,
        finished=True,
    )
    return Interest(
        era=era,
        watches=[watch],
        weights=[1.0],
        centroid=np.asarray(_vec(angle, axis), dtype=np.float32),
        queries=["a search"],
        name=name,
        named_by=named_by,
    )


def test_a_category_keeps_its_id_and_name_as_the_history_moves(session, admin_user):
    [first] = category_store.sync(
        session, admin_user.id, [_group(0.0, name="Home Servers")], NOW
    )
    # The same interest, re-clustered: a slightly different centre, another name.
    [again] = category_store.sync(
        session, admin_user.id, [_group(0.2, name="Server Racks")], NOW
    )
    assert (again.id, again.name) == (first.id, "Home Servers")
    assert category_store.centre(again)[1] == pytest.approx(math.sin(0.2), abs=1e-5)
    # A chat model's name replaces one made from title words, never the reverse.
    [named] = category_store.sync(
        session, admin_user.id, [_group(0.2, name="Homelab", named_by="llm")], NOW
    )
    assert (named.id, named.name) == (first.id, "Homelab")
    [kept] = category_store.sync(
        session, admin_user.id, [_group(0.2, name="Server Words")], NOW
    )
    assert kept.name == "Homelab"


def test_an_interest_that_left_is_forgotten_after_a_while(session, admin_user):
    category_store.sync(session, admin_user.id, [_group(0.0, name="Old")], NOW)
    other = [_group(0.0, axis=2, name="New")]
    soon = NOW + timedelta(days=3)
    assert {
        r.name for r in category_store.sync(session, admin_user.id, other, soon)
    } == {
        "Old",
        "New",
    }
    later = NOW + timedelta(days=20)
    assert [
        r.name for r in category_store.sync(session, admin_user.id, other, later)
    ] == ["New"]


def test_categories_of_another_vector_size_are_replaced(session, admin_user):
    session.add(
        RecCategory(
            user_id=admin_user.id,
            name="Stale",
            centroid=embeddings.pack_vector([1.0, 0.0]),
            dim=2,
        )
    )
    session.commit()
    rows = category_store.sync(session, admin_user.id, [_group(0.0, name="Now")], NOW)
    assert [r.name for r in rows] == ["Now"]


def test_a_group_without_a_name_or_a_centre_is_no_category(session, admin_user):
    nameless = _group(0.0)
    flat = _group(0.0, name="Channel")
    flat.centroid = None
    assert category_store.sync(session, admin_user.id, [nameless, flat], NOW) == []


def test_half_life_follows_how_old_the_watched_videos_were():
    assert category_store.half_life([10.0] * 8) == 90.0  # this month's uploads
    assert category_store.half_life([400.0] * 8) == 800.0
    assert category_store.half_life([1200.0] * 8) is None  # old videos: age is moot
    assert category_store.half_life([10.0] * 4) is None  # too little to tell


# --- what a category shows -----------------------------------------------------


def _cand(key, channel, vec, *, pool="discovery", days_old=30, views=10_000):
    c = Candidate(
        key=key,
        pool=pool,
        title=key,
        channel=channel,
        channel_url=f"https://www.youtube.com/@{channel.lower()}",
        yt_id=key,
        published=NOW - timedelta(days=days_old),
        view_count=views,
    )
    c.vec = vec  # type: ignore[attr-defined]  # test-only: read by the fake sims
    return c


@pytest.fixture
def measure(monkeypatch, session, admin_user):
    """``measure(pool, categories, ...)`` -> the Browse for that pool."""

    def sims(_session, _runtime, cands, seeds):
        out = np.full((len(cands), len(seeds)), np.nan, dtype=np.float32)
        for i, c in enumerate(cands):
            vec = getattr(c, "vec", None)
            if vec is not None:
                out[i] = np.asarray(vec, dtype=np.float32) @ seeds.T
        return out

    monkeypatch.setattr(category_feed, "candidate_sims", sims)
    monkeypatch.setattr(category_feed, "MIN_CATEGORY_PICKS", 1)

    def run(pool, categories, *, known=(), tuning=DEFAULTS, half_life=None):
        for row in session.exec(select(RecCategory)).all():
            session.delete(row)
        session.commit()
        ids = {}
        for n, (name, vec) in enumerate(categories):
            row = RecCategory(
                user_id=admin_user.id,
                name=name,
                dim=len(vec),
                centroid=embeddings.pack_vector(vec),
                weight=10 - n,
                half_life_days=(half_life or {}).get(name),
            )
            session.add(row)
            session.commit()
            ids[name] = row.id
        feed = Feed([], {}, False, pool=pool, known_channels=set(known))
        browse = category_feed.prepare(
            session, None, feed, admin_user.id, 1, tuning, NOW
        )
        return browse, ids

    return run


CATS = [("Code", _vec(0.0)), ("Hardware", _vec(0.0, 2)), ("Wood", _vec(0.0, 4))]


def _keys(browse, cat_id, *, loose=None):
    return [
        i.candidate.key
        for i in browse.listing(cat_id).items
        if loose is None or i.loose == loose
    ]


def test_a_video_is_in_its_nearest_category_only(measure):
    pool = (
        [_cand(f"code{n}", f"C{n}", _vec(0.05 * n)) for n in range(6)]
        + [_cand(f"hard{n}", f"H{n}", _vec(0.05 * n, 2)) for n in range(6)]
        + [_cand(f"wood{n}", f"W{n}", _vec(0.05 * n, 4)) for n in range(6)]
        # Between code and hardware, nearer hardware.
        + [_cand("review", "Mixed", [0.6, 0.0, 0.8, 0.0, 0.0, 0.0])]
        + [_cand("novector", "Plain", None)]
    )
    browse, ids = measure(pool, CATS)
    assert [c.name for c in browse.listed] == ["Code", "Hardware", "Wood"]
    assert set(_keys(browse, ids["Code"], loose=False)) == {
        f"code{n}" for n in range(6)
    }
    assert "review" in _keys(browse, ids["Hardware"], loose=False)
    # In Code it is only further afield, after every close match.
    assert "review" in _keys(browse, ids["Code"], loose=True)
    assert _keys(browse, ids["Code"])[:6] == _keys(browse, ids["Code"], loose=False)
    assert all("novector" not in _keys(browse, i) for i in ids.values())


def test_old_videos_sink_only_where_the_user_watches_recent_ones(measure):
    pool = (
        [_cand(f"new{n}", f"C{n}", _vec(0.02 * n), days_old=20) for n in range(6)]
        + [_cand("ipad2022", "Old", _vec(0.01), days_old=4 * 365)]
        + [_cand(f"wood{n}", f"W{n}", _vec(0.05 * n, 4)) for n in range(6)]
    )
    browse, ids = measure(pool, CATS, half_life={"Code": 90.0})
    assert "ipad2022" in _keys(browse, ids["Code"], loose=True)
    # No half-life (they watch old videos here): it is as close as it looks.
    browse, ids = measure(pool, CATS)
    assert "ipad2022" in _keys(browse, ids["Code"], loose=False)


def test_no_channel_fills_a_category(measure):
    pool = (
        [_cand(f"big{n}", "Big", _vec(0.001 * n), pool="catalog") for n in range(30)]
        + [
            _cand(f"a{n}", "Aa", _vec(0.1 + 0.001 * n), pool="catalog")
            for n in range(6)
        ]
        + [
            _cand(f"b{n}", "Bb", _vec(0.12 + 0.001 * n), pool="catalog")
            for n in range(6)
        ]
        + [
            _cand(f"c{n}", "Cc", _vec(0.14 + 0.001 * n), pool="catalog")
            for n in range(6)
        ]
        + [_cand(f"wood{n}", f"W{n}", _vec(0.05 * n, 4)) for n in range(6)]
    )
    browse, ids = measure(pool, CATS)
    channels = [i.candidate.channel for i in browse.listing(ids["Code"]).items]
    # While the others have something to show, Big is at most one in four.
    for start in range(20):
        assert channels[start : start + 4].count("Big") <= 1
    assert channels.count("Big") == 30  # nothing dropped, only spaced out


def _new_in_first(browse, cat_id, places=24):
    return sum(1 for i in browse.listing(cat_id).items[:places] if i.bucket == "new")


def test_new_channels_follow_the_lead_and_never_sit_together(measure):
    pool = (
        [
            _cand(f"lib{n}", f"L{n % 9}", _vec(0.001 * n), pool="library")
            for n in range(60)
        ]
        + [_cand(f"new{n}", f"N{n}", _vec(0.001 * n)) for n in range(30)]
        + [_cand(f"wood{n}", f"W{n}", _vec(0.05 * n, 4)) for n in range(6)]
    )
    browse, ids = measure(pool, CATS)
    kinds = [i.bucket for i in browse.listing(ids["Code"]).items if not i.loose]
    assert kinds[:3] == ["similar"] * 3
    woven = kinds[: kinds.index("new") + 40]
    assert all(pair != ("new", "new") for pair in zip(woven, woven[1:], strict=False))
    assert kinds.count("new") == 30  # all of them, the leftovers at the end


def test_the_algorithm_and_the_supply_set_how_much_is_new(measure):
    def pool(familiar):
        return (
            [
                _cand(f"lib{n}", f"L{n % 9}", _vec(0.001 * n), pool="library")
                for n in range(familiar)
            ]
            + [_cand(f"new{n}", f"N{n}", _vec(0.001 * n)) for n in range(60)]
            + [_cand(f"wood{n}", f"W{n}", _vec(0.05 * n, 4)) for n in range(6)]
        )

    by_id = {p.id: p.tuning for p in PRESETS}
    plenty, ids = measure(pool(60), CATS, tuning=by_id["explorer"])
    explorer = _new_in_first(plenty, ids["Code"])
    plenty, ids = measure(pool(60), CATS, tuning=by_id["familiar"])
    familiar = _new_in_first(plenty, ids["Code"])
    assert explorer > familiar > 0
    # Little that is familiar: more of the top goes to new channels.
    thin, ids = measure(pool(12), CATS, tuning=by_id["familiar"])
    assert _new_in_first(thin, ids["Code"]) > familiar


def test_a_channel_the_user_watches_is_familiar(measure):
    pool = [_cand(f"v{n}", "Known", _vec(0.01 * n)) for n in range(4)] + [
        _cand(f"wood{n}", f"W{n}", _vec(0.05 * n, 4)) for n in range(6)
    ]
    browse, ids = measure(pool, CATS, known={"known"})
    assert {i.bucket for i in browse.listing(ids["Code"]).items if not i.loose} == {
        "similar"
    }
    assert browse.listing(ids["Code"]).channels == {}


def test_later_finds_join_the_end_of_a_list(measure):
    pool = [_cand(f"code{n}", f"C{n}", _vec(0.05 * n)) for n in range(6)] + [
        _cand(f"wood{n}", f"W{n}", _vec(0.05 * n, 4)) for n in range(6)
    ]
    browse, ids = measure(pool, CATS)
    before = _keys(browse, ids["Code"])
    added = browse.append(
        None,
        None,
        ids["Code"],
        [
            _cand("found1", "F", _vec(0.02)),
            _cand("code1", "C1", _vec(0.05)),  # already listed
            _cand("offtopic", "F", _vec(0.0, 2)),
            _cand("blank", "F", None),
        ],
    )
    assert added == 1
    assert _keys(browse, ids["Code"]) == [*before, "found1"]


def test_without_vectors_there_are_no_categories(measure):
    browse, ids = measure([_cand("plain", "P", None)], CATS)
    assert browse.listed == []
    assert _keys(browse, ids["Code"]) == []


def test_a_later_find_off_the_topic_stays_out_of_a_one_topic_pool(measure):
    """Everything known is about as near to the category (no scale to place a
    newcomer on): a find joins only when it is as near too."""
    pool = [_cand(f"code{n}", f"C{n}", _vec(0.001 * n)) for n in range(6)]
    browse, ids = measure(pool, [("Code", _vec(0.0))])
    added = browse.append(
        None,
        None,
        ids["Code"],
        [_cand("near", "F", _vec(0.002)), _cand("far", "F", _vec(0.0, 2))],
    )
    assert added == 1
    assert _keys(browse, ids["Code"])[-1] == "near"


def test_a_second_row_for_the_same_interest_is_dropped(session, admin_user):
    for _ in range(2):  # two refreshes at once each made the row
        session.add(
            RecCategory(
                user_id=admin_user.id,
                name="Twin",
                dim=6,
                centroid=embeddings.pack_vector(_vec(0.0)),
            )
        )
    session.commit()
    rows = category_store.sync(session, admin_user.id, [_group(0.0, name="Twin")], NOW)
    assert [r.name for r in rows] == ["Twin"]


def test_searches_from_a_chat_model_are_kept_by_a_keyword_refresh(session, admin_user):
    llm = _group(0.0, name="Homelab", named_by="llm")
    llm.queries = ["rack mount home server build"]
    category_store.sync(session, admin_user.id, [llm], NOW)
    words = _group(0.0, name="Server Words")
    words.queries = ["server words"]
    [row] = category_store.sync(
        session, admin_user.id, [words], NOW, keep_searches=True
    )
    assert category_store.queries(row) == ["rack mount home server build"]
