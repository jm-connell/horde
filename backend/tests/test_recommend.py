"""Whole-video scoring: categories, "For you", related videos, and the LLM prompts behind them.

Vectors are hand made and tiny (4 dimensions) so the expected order is plain from
the numbers: ``_unit(c)`` is a unit vector whose cosine to ``[1, 0, 0, 0]`` is ``c``.
"""

from __future__ import annotations

import json
import math
import random
import re
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlmodel import delete, select

from app.models import AiCategory, Video, VideoEmbedding
from app.services import follows, library
from app.services.ai import embeddings, recommend, tasks, vector_index
from app.services.ai import workload as ai_workload

X_AXIS = [1.0, 0.0, 0.0, 0.0]


def _unit(c: float) -> list[float]:
    return [c, math.sqrt(1 - c * c), 0.0, 0.0]


def _embed(session, video, vec, *, chunk=-1):
    session.add(
        VideoEmbedding(
            video_id=video.id,
            chunk_index=chunk,
            model="m",
            dim=len(vec),
            vector=embeddings.pack_vector(vec),
            content_hash="h",
        )
    )
    session.commit()


def _embedded(session, add_video, vec, **fields):
    video = add_video(**fields)
    _embed(session, video, vec)
    return video


def _category(session, name, vec):
    session.add(
        AiCategory(
            name=name,
            embedding=embeddings.pack_vector(vec),
            dim=len(vec),
            model="m",
        )
    )
    session.commit()


# --- vector_index.video_scores ------------------------------------------------


def _profile(meta, captions):
    """Reference: unit(metadata) + 0.5 * unit(sum of caption chunks), normalised."""
    unit = embeddings.l2_normalize
    total = (
        [sum(col) for col in zip(*map(unit, captions), strict=True)]
        if captions
        else None
    )
    parts = unit(meta)
    if total:
        parts = [m + 0.5 * c for m, c in zip(parts, unit(total), strict=True)]
    return unit(parts)


def test_video_scores_match_the_profile_definition(session, add_video):
    queries = [[1.0, 0.0, 0.0, 0.0], [3.0, 4.0, 0.0, 0.0]]
    specs = {
        "meta only": ([1.0, 1.0, 0.0, 0.0], []),
        "meta and captions agree": ([1.0, 0.0, 0.0, 0.0], [[2.0, 0.0, 0.0, 0.0]]),
        "uneven captions": (
            [1.0, 0.0, 0.0, 0.0],
            [[2.0, 0.0, 0.0, 0.0], [0.0, 3.0, 0.0, 0.0]],
        ),
        "captions match, metadata does not": (
            [0.0, 1.0, 0.0, 0.0],
            [[1.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]],
        ),
    }
    expected = {}
    id_of = {}
    for title, (meta, captions) in specs.items():
        video = add_video(title=title)
        _embed(session, video, meta)
        for i, vec in enumerate(captions):
            _embed(session, video, vec, chunk=i)
        expected[video.id] = [
            embeddings.cosine(_profile(meta, captions), q) for q in queries
        ]
        id_of[title] = video.id

    ids, scores = vector_index.video_scores(session, queries)

    assert sorted(ids.tolist()) == sorted(expected)
    assert scores.shape == (len(specs), 2)
    for vid, row in zip(ids.tolist(), scores, strict=True):
        assert row.tolist() == pytest.approx(expected[vid], abs=1e-5)
    by_title = {t: scores[ids.tolist().index(v)][0] for t, v in id_of.items()}
    assert by_title["meta and captions agree"] == pytest.approx(1.0, abs=1e-5)
    # A caption that matches perfectly does not carry a video whose metadata does not.
    assert by_title["captions match, metadata does not"] == pytest.approx(
        0.447, abs=0.01
    )


def test_video_scores_follow_embedding_changes(session, add_video):
    video = add_video(title="Changing")
    other = add_video(title="Steady")
    _embed(session, video, [0.0, 1.0, 0.0, 0.0])
    _embed(session, other, [0.0, 0.0, 1.0, 0.0])

    def score() -> float:
        ids, scores = vector_index.video_scores(session, [X_AXIS])
        return float(scores[ids.tolist().index(video.id), 0])

    assert score() == pytest.approx(0.0, abs=1e-6)
    _embed(session, video, X_AXIS, chunk=0)  # a caption joins: profile moves
    assert score() == pytest.approx(0.447, abs=0.01)
    row = session.exec(
        select(VideoEmbedding).where(
            VideoEmbedding.video_id == video.id, VideoEmbedding.chunk_index == -1
        )
    ).one()
    row.vector = embeddings.pack_vector(X_AXIS)  # metadata replaced
    session.add(row)
    session.commit()
    assert score() == pytest.approx(1.0, abs=1e-5)
    session.delete(row)
    session.commit()
    assert score() == pytest.approx(1.0, abs=1e-5)  # captions alone remain


def test_profile_vectors_are_the_scored_vectors(session, add_video):
    video = add_video(title="A")
    bare = add_video(title="No embeddings")
    _embed(session, video, [0.0, 2.0, 0.0, 0.0])
    _embed(session, video, X_AXIS, chunk=0)

    got = vector_index.profile_vectors(session, [video.id, bare.id])

    assert list(got) == [video.id]
    want = _profile([0.0, 2.0, 0.0, 0.0], [X_AXIS])
    assert got[video.id] == pytest.approx(want, abs=1e-5)
    _ids, scores = vector_index.video_scores(session, [X_AXIS])
    assert scores[0, 0] == pytest.approx(embeddings.cosine(got[video.id], X_AXIS))


def test_video_scores_of_an_empty_index(session):
    ids, scores = vector_index.video_scores(session, [X_AXIS])
    assert ids.size == 0
    assert scores.shape[0] == 0


# --- categories ---------------------------------------------------------------


def test_video_belongs_only_to_its_best_category(session, add_video):
    _category(session, "Alpha", [1.0, 0.0, 0.0, 0.0])
    _category(session, "Beta", [0.0, 1.0, 0.0, 0.0])
    pure_a = _embedded(session, add_video, [1.0, 0.05, 0.0, 0.0], title="Pure A")
    pure_b = _embedded(session, add_video, [0.05, 1.0, 0.0, 0.0], title="Pure B")
    # cosine 0.78 to Alpha and 0.62 to Beta: clears the 0.55 minimum for both.
    mixed = _embedded(session, add_video, [1.0, 0.8, 0.0, 0.0], title="Mostly A")

    alpha = recommend.videos_for_category(session, "Alpha")
    beta = recommend.videos_for_category(session, "Beta")

    assert {v.id for v in alpha.videos} == {pure_a.id, mixed.id}
    assert [v.id for v in beta.videos] == [pure_b.id]
    assert alpha.categories == ["Alpha", "Beta"]


def test_category_that_only_loses_its_videos_is_not_listed(session, add_video):
    _category(session, "Alpha", [1.0, 0.0, 0.0, 0.0])
    _category(session, "Beta", [0.0, 1.0, 0.0, 0.0])
    # Close to Alpha (0.89), so every video near it is a better match for Alpha.
    _category(session, "Shadow", [1.0, 0.5, 0.0, 0.0])
    _embedded(session, add_video, [1.0, 0.05, 0.0, 0.0], title="A")
    _embedded(session, add_video, [0.05, 1.0, 0.0, 0.0], title="B")

    assert recommend.list_categories(session) == ["Alpha", "Beta"]
    assert recommend.list_categories(session, nonempty_only=False) == [
        "Alpha",
        "Beta",
        "Shadow",
    ]
    assert recommend.videos_for_category(session, "Shadow").videos == []


def test_categories_skip_videos_waiting_for_review(session, add_video):
    _category(session, "Alpha", [1.0, 0.0, 0.0, 0.0])
    _category(session, "Hidden only", [0.0, 0.0, 1.0, 0.0])
    shown = _embedded(session, add_video, [1.0, 0.05, 0.0, 0.0], title="Shown")
    hidden_a = _embedded(
        session, add_video, [1.0, 0.0, 0.0, 0.0], title="Hidden A", needs_review=True
    )
    _embedded(
        session, add_video, [0.0, 0.0, 1.0, 0.0], title="Hidden C", needs_review=True
    )

    assert recommend.list_categories(session) == ["Alpha"]
    page = recommend.videos_for_category(session, "Alpha")
    assert [v.id for v in page.videos] == [shown.id]
    assert hidden_a.id not in {v.id for v in page.videos}


# --- "For you" ----------------------------------------------------------------


@pytest.fixture
def for_you(session, admin_user, monkeypatch):
    monkeypatch.setattr(recommend, "get_embed_provider", lambda: object())

    def ids() -> list[int]:
        page = recommend.homepage_recommendations_page(
            session, user_id=admin_user.id, limit=50, offset=0
        )
        return [v.id for v in page.videos]

    return ids


def test_for_you_lists_watched_videos_after_unwatched_ones(
    session, add_video, admin_user, set_watch, for_you
):
    close = _embedded(session, add_video, _unit(0.8), title="Close", channel="C1")
    nearish = _embedded(
        session, add_video, [0.4, 0.9, 0.0, 0.0], title="Nearish", channel="C2"
    )
    unrelated = _embedded(
        session, add_video, [0.0, 0.0, 0.0, 1.0], title="Unrelated", channel="C3"
    )
    # Added last, so a recency fill would put them first.
    seed = _embedded(session, add_video, X_AXIS, title="Seed", channel="C4")
    twin = _embedded(
        session, add_video, [1.0, 0.1, 0.0, 0.0], title="Twin", channel="C5"
    )
    now = datetime.now(UTC)
    set_watch(admin_user, seed, 590, now)
    set_watch(admin_user, twin, 590, now - timedelta(hours=1))

    assert for_you() == [close.id, nearish.id, unrelated.id, seed.id, twin.id]


def test_for_you_prefers_recent_and_finished_seeds(
    session, add_video, admin_user, set_watch, for_you
):
    recent_seed = _embedded(
        session, add_video, X_AXIS, title="Recent", channel="C1", duration_sec=600.0
    )
    old_seed = _embedded(
        session,
        add_video,
        [0.0, 1.0, 0.0, 0.0],
        title="Old",
        channel="C2",
        duration_sec=600.0,
    )
    # A touch closer to its seed than the other neighbour is to its own...
    near_old = _embedded(
        session, add_video, [0.0, 0.85, 0.0, 0.5268], title="Near old", channel="C3"
    )
    near_recent = _embedded(
        session, add_video, [0.8, 0.0, 0.6, 0.0], title="Near recent", channel="C4"
    )
    now = datetime.now(UTC)
    set_watch(admin_user, recent_seed, 580, now)  # watched to the end
    set_watch(admin_user, old_seed, 10, now - timedelta(days=10))  # abandoned

    # ...yet the neighbour of the fresh, finished watch comes first.
    assert for_you()[:2] == [near_recent.id, near_old.id]


def test_for_you_spreads_a_channel_across_the_shelf(
    session, add_video, admin_user, set_watch, for_you
):
    set_watch(
        admin_user,
        _embedded(session, add_video, X_AXIS, title="Seed", channel="Seed channel"),
        590,
    )
    xs = [
        _embedded(session, add_video, _unit(0.8), title=f"X{i}", channel="X")
        for i in range(3)
    ]
    y = _embedded(session, add_video, _unit(0.78), title="Y", channel="Y")

    order = for_you()[:4]
    assert order == [xs[0].id, y.id, xs[1].id, xs[2].id]


def test_for_you_boosts_followed_channels(
    session, add_video, admin_user, set_watch, for_you
):
    set_watch(
        admin_user,
        _embedded(session, add_video, X_AXIS, title="Seed", channel="Seed channel"),
        590,
    )
    url = "https://www.youtube.com/@followed"
    other = _embedded(session, add_video, _unit(0.79), title="Other", channel="Other")
    liked = _embedded(
        session,
        add_video,
        _unit(0.77),
        title="Followed",
        channel="Followed",
        channel_url=url,
    )
    assert for_you()[:2] == [other.id, liked.id]

    follows.follow(session, admin_user.id, url)

    assert for_you()[:2] == [liked.id, other.id]


# --- related videos -----------------------------------------------------------


@pytest.fixture
def embed_ready(monkeypatch):
    monkeypatch.setattr("app.services.ai.provider.get_embed_provider", lambda: object())


def test_related_pages_continue_the_embedding_order(
    session, add_video, client, embed_ready
):
    source = _embedded(session, add_video, X_AXIS, title="Source", channel="Src")
    # Added most similar first, so recency (the non-AI fill) runs the other way.
    ranked = [
        _embedded(
            session,
            add_video,
            [math.cos(0.05 * (i + 1)), math.sin(0.05 * (i + 1)), 0.0, 0.0],
            title=f"Cand {i}",
            channel="Other",
        )
        for i in range(18)
    ]

    def page(offset: int) -> list[int]:
        res = client.get(
            f"/api/videos/{source.id}/related", params={"limit": 8, "offset": offset}
        )
        assert res.status_code == 200
        return [v["id"] for v in res.json()]

    first, second, third = page(0), page(8), page(16)
    expected = [v.id for v in ranked]
    assert first == expected[:8]
    assert second == expected[8:16]
    assert third == expected[16:]
    assert len({*first, *second, *third}) == 18


def test_related_demotes_videos_the_user_has_watched(
    session, add_video, admin_user, set_watch, embed_ready
):
    source = _embedded(session, add_video, X_AXIS, title="Source", channel="Src")
    watched = _embedded(session, add_video, _unit(0.90), title="Watched", channel="A")
    fresh = _embedded(session, add_video, _unit(0.88), title="Fresh", channel="B")
    set_watch(admin_user, watched, 100)

    plain = library.related_videos(session, source.id, limit=2)
    personal = library.related_videos(
        session, source.id, limit=2, user_id=admin_user.id
    )

    assert [v.id for v in plain] == [watched.id, fresh.id]
    assert [v.id for v in personal] == [fresh.id, watched.id]


def test_related_rare_shared_tags_count_for_more(session, add_video, embed_ready):
    source = _embedded(
        session,
        add_video,
        X_AXIS,
        title="Source",
        channel="Src",
        tags=["rare", "common"],
    )
    rare = _embedded(
        session, add_video, _unit(0.60), title="Rare", channel="A", tags=["rare"]
    )
    common = _embedded(
        session, add_video, _unit(0.61), title="Common", channel="B", tags=["common"]
    )
    for i in range(6):
        add_video(title=f"Filler {i}", channel=f"F{i}", tags=["common"])

    picked = library.related_videos(session, source.id, limit=2)

    assert [v.id for v in picked][:2] == [rare.id, common.id]


# --- run_refresh_categories ---------------------------------------------------

GROUPS = {
    "Gaming": [1.0, 0.0, 0.0, 0.05],
    "Cooking": [0.0, 1.0, 0.0, 0.05],
    "Travel": [0.0, 0.0, 1.0, 0.05],
}


class FakeLlm:
    def __init__(self, reply):
        self.reply = reply
        self.prompts: list[str] = []

    def chat(self, prompt, model, **kwargs):
        self.prompts.append(prompt)
        return json.dumps(self.reply(prompt))


class FakeEmbedder:
    """Embeds text as the first group vector whose name it mentions, else a flat one."""

    def __init__(self, *, by_name: bool):
        self.by_name = by_name

    def has_model(self, _model):
        return True

    def embed(self, text, model, **kwargs):
        if self.by_name:
            for name, vec in GROUPS.items():
                if name in text:
                    return list(vec)
        return [1.0, 1.0, 1.0, 1.0]


def _sample_numbers(prompt: str) -> dict[str, int]:
    """Prompt number of each sample video, by title."""
    return {
        title.strip(): int(n)
        for n, title in re.findall(r"^\[(\d+)\] Title: (.*)$", prompt, re.MULTILINE)
    }


@pytest.fixture
def category_library(session, add_video):
    for group, vec in GROUPS.items():
        for i in range(3):
            _embedded(session, add_video, vec, title=f"{group} clip {i}")


@pytest.fixture
def category_env(monkeypatch):
    def install(llm, *, by_name: bool):
        monkeypatch.setattr(
            tasks, "get_embed_provider", lambda: FakeEmbedder(by_name=by_name)
        )
        monkeypatch.setattr(tasks, "get_llm_provider", lambda: llm)
        monkeypatch.setattr(tasks, "require_llm_chat_model", lambda *a, **k: None)
        monkeypatch.setattr(tasks, "resolve_llm_model", lambda *a, **k: "chat")
        monkeypatch.setattr(tasks, "resolve_embed_model", lambda *a, **k: "embed")
        monkeypatch.setattr(
            ai_workload,
            "detect_gpu_for_ai",
            lambda *a, **k: (ai_workload.gpu_from_vram_gb(12), "override", None),
        )

    return install


def _stored(session) -> dict[str, list[float]]:
    return {
        row.name: embeddings.unpack_vector(row.embedding, row.dim)
        for row in session.exec(select(AiCategory)).all()
    }


def test_refresh_categories_uses_labelled_examples(
    session, category_library, category_env
):
    def reply(prompt):
        nums = _sample_numbers(prompt)
        cats = [
            {
                "name": group,
                "blurb": f"About {group}",
                "examples": [nums[f"{group} clip {i}"] for i in range(3)],
            }
            for group in GROUPS
        ]
        cats.append({"name": "Invented", "blurb": "No such videos", "examples": [999]})
        # One labelled example is not enough to back a category.
        cats.append(
            {"name": "Thin", "blurb": "One video", "examples": [nums["Gaming clip 0"]]}
        )
        return {"categories": cats}

    llm = FakeLlm(reply)
    category_env(llm, by_name=False)

    tasks.run_refresh_categories(session)

    assert "[1] Title:" in llm.prompts[0]
    stored = _stored(session)
    assert set(stored) == set(GROUPS)
    for group, vec in GROUPS.items():
        # The label text embeds to the same flat vector for every group (cosine 0.5
        # to each); the examples' centroid is what points it at its own videos.
        flat = embeddings.cosine([1.0, 1.0, 1.0, 1.0], vec)
        assert embeddings.cosine(stored[group], vec) > 0.8
        assert embeddings.cosine(stored[group], vec) > flat + 0.25


def test_refresh_categories_falls_back_to_embedding_when_examples_are_ignored(
    session, category_library, category_env
):
    def reply(prompt):
        return {"categories": [{"name": g, "blurb": f"About {g}"} for g in GROUPS]}

    category_env(FakeLlm(reply), by_name=True)

    tasks.run_refresh_categories(session)

    stored = _stored(session)
    assert set(stored) == set(GROUPS)
    for group, vec in GROUPS.items():
        best = max(GROUPS, key=lambda g: embeddings.cosine(stored[group], GROUPS[g]))
        assert best == group
        assert embeddings.cosine(stored[group], vec) > 0.95


# --- run_enrich_tags ----------------------------------------------------------


def test_enrich_tags_reuses_the_librarys_spelling(session, add_video, monkeypatch):
    add_video(title="Game one", channel="A", tags=["Gaming", "Solo"])
    add_video(title="Game two", channel="B", tags=["Gaming"])
    target = add_video(title="Game three", channel="C", tags=[])
    llm = SimpleNamespace(
        prompts=[],
        chat=lambda prompt, model, **kw: (
            llm.prompts.append(prompt)
            or json.dumps({"tags": ["gaming", "speedrun"], "remove": []})
        ),
    )
    monkeypatch.setattr(tasks, "get_llm_provider", lambda: llm)
    monkeypatch.setattr(tasks, "require_llm_chat_model", lambda *a, **k: None)

    assert tasks.run_enrich_tags(session, target.id) is None

    prompt = llm.prompts[0]
    assert "Library tags:" in prompt
    assert "Gaming" in prompt
    assert "Solo" not in prompt  # on a single video: not a shared vocabulary yet
    session.expire_all()
    tags = library.parse_tags(session.get(Video, target.id).tags)
    assert tags == ["Gaming", "speedrun"]


def test_enrich_tags_keeps_distinct_tags_that_normalise_alike(
    session, add_video, monkeypatch
):
    for title in ("One", "Two"):
        add_video(title=title, channel="A", tags=["C++", "News", "Glass"])
    target = add_video(title="Three", channel="C", tags=[])
    llm = SimpleNamespace(
        chat=lambda prompt, model, **kw: json.dumps(
            {"tags": ["C#", "new", "Glasses", "news"], "remove": []}
        )
    )
    monkeypatch.setattr(tasks, "get_llm_provider", lambda: llm)
    monkeypatch.setattr(tasks, "require_llm_chat_model", lambda *a, **k: None)

    assert tasks.run_enrich_tags(session, target.id) is None

    session.expire_all()
    tags = library.parse_tags(session.get(Video, target.id).tags)
    # Only a difference in case takes the library's spelling.
    assert tags == ["C#", "new", "Glasses"]


# --- review regressions -------------------------------------------------------


def test_finished_seed_counts_fully():
    # The player records a finished video as position 0.
    assert recommend._engagement(0.0, 600.0) == recommend._engagement(400.0, 600.0)
    assert recommend._engagement(10.0, 600.0) < recommend._engagement(0.0, 600.0)


def test_diversify_matches_greedy_selection():
    rng = random.Random(5)  # noqa: S311 - deterministic test data
    penalty = recommend.CHANNEL_REPEAT_PENALTY

    def greedy(scored, channels):
        left, picks, out = dict(scored), {}, []
        while left:
            vid = min(
                left,
                key=lambda v: (
                    -(left[v] - penalty * picks.get(channels.get(v) or v, 0)),
                    v,
                ),
            )
            key = channels.get(vid) or vid
            picks[key] = picks.get(key, 0) + 1
            out.append(vid)
            del left[vid]
        return out

    for _ in range(100):
        n = rng.randint(0, 30)
        # Scores on a 1/1024 grid so penalised ties compare exactly.
        scored = {i: rng.randint(200, 800) / 1024 for i in range(n)}
        channels = {i: rng.choice(["a", "b", "c", ""]) for i in range(n)}
        assert recommend._diversify(scored, channels) == greedy(scored, channels)


def test_profiles_stay_exact_through_incremental_changes(session, add_video):
    rng = random.Random(1)  # noqa: S311 - deterministic test data
    videos = [add_video(title=f"P{i}") for i in range(40)]

    def vec():
        return [rng.uniform(-1, 1) for _ in range(4)]

    def store(video):
        _embed(session, video, vec())
        for chunk in range(rng.randint(0, 3)):
            _embed(session, video, vec(), chunk=chunk)

    def check():
        rows = session.exec(select(VideoEmbedding)).all()
        by_video: dict[int, tuple[list[float], list[list[float]]]] = {}
        for row in rows:
            meta, captions = by_video.setdefault(row.video_id, ([], []))
            vector = embeddings.unpack_vector(row.vector, row.dim)
            if row.chunk_index == -1:
                meta.extend(vector)
            else:
                captions.append(vector)
        expected = {vid: _profile(m, c) for vid, (m, c) in by_video.items()}
        got = vector_index.profile_vectors(session, list(expected))
        assert set(got) == set(expected)
        for vid, profile in expected.items():
            assert got[vid] == pytest.approx(profile, abs=1e-5)

    for video in videos:
        store(video)
    check()
    for _ in range(15):
        video = rng.choice(videos)
        session.exec(delete(VideoEmbedding).where(VideoEmbedding.video_id == video.id))
        session.commit()
        if rng.random() < 0.7:
            store(video)
        check()


def test_related_pages_are_one_ranking_when_scores_are_close(
    session, add_video, embed_ready
):
    source = add_video(title="Source", channel="S", tags=["rare", "common"])
    _embed(session, source, [1.0, 0.0])
    for i in range(120):
        sim = 0.95 - i * 0.001
        video = add_video(
            title=f"Close {i}",
            channel="S" if i % 7 == 0 else f"C{i}",
            tags=["rare"] if i % 11 == 0 else ["common"],
        )
        _embed(session, video, [sim, math.sqrt(1 - sim * sim)])

    def page(offset, limit):
        rows = library.related_videos(session, source.id, limit=limit, offset=offset)
        return [v.id for v in rows]

    by_eight = [vid for offset in range(0, 48, 8) for vid in page(offset, 8)]
    assert by_eight == page(0, 24) + page(24, 24)
    assert len(set(by_eight)) == 48


# --- "For you" without AI, and followed channels' uploads -----------------------


def _for_you_items(client, **params) -> list[tuple[str, str]]:
    res = client.get("/api/ai/recommendations", params={"limit": 50, **params})
    assert res.status_code == 200, res.text
    sections = res.json()["sections"]
    items = sections[0]["items"] if sections else []
    return [
        ("video", i["video"]["title"])
        if i["video"]
        else ("stream", i["stream"]["title"])
        for i in items
    ]


def test_for_you_without_ai_ranks_by_watched_channels_and_tags(
    client, session, add_video, admin_user, set_watch
):
    now = datetime.now(UTC)
    seen = add_video(title="Seen", channel="Loved", tags=["kiln"])
    set_watch(admin_user, seen, 0, now)  # finished
    add_video(title="More from Loved", channel="Loved")
    add_video(title="Also kilns", channel="Other", tags=["kiln"])
    add_video(title="Unrelated", channel="Nobody")

    titles = [t for _kind, t in _for_you_items(client)]
    assert titles == ["More from Loved", "Also kilns", "Unrelated", "Seen"]
    # Categories need AI; the shelf does not.
    assert client.get("/api/ai/recommendations").json()["categories"] == []


def test_for_you_mixes_in_followed_channels_uploads_on_request(
    client, session, add_video, admin_user, set_watch
):
    from app.models import ChannelCatalog, ChannelCatalogStatus, ChannelCatalogVideo
    from app.services import follows

    url = "https://www.youtube.com/@loved"
    seen = add_video(
        title="Seen", channel="Loved", channel_url=url, source_url=_yt("haveitttt01")
    )
    set_watch(admin_user, seen, 0, datetime.now(UTC))
    follows.follow(session, admin_user.id, url, "Loved")
    catalog = ChannelCatalog(
        channel_url=url, channel_name="Loved", status=ChannelCatalogStatus.ready
    )
    session.add(catalog)
    session.commit()
    recent = datetime.now(UTC).strftime("%Y%m%d")
    for pos, (yt_id, title, live) in enumerate(
        [
            ("liveeeeeee1", "Live right now", "is_live"),  # the Live row has it
            ("haveitttt01", "Seen", None),  # downloaded: the library copy is listed
            ("newupload01", "New upload", None),
        ]
    ):
        session.add(
            ChannelCatalogVideo(
                catalog_id=catalog.id,
                yt_id=yt_id,
                url=_yt(yt_id),
                title=title,
                duration=600.0,
                position=pos,
                published_at=recent,
                live_status=live,
            )
        )
    session.commit()

    assert ("stream", "New upload") not in _for_you_items(client)
    assert _for_you_items(client, include_streams=True) == [
        ("stream", "New upload"),
        ("video", "Seen"),
    ]


def _yt(yt_id: str) -> str:
    return f"https://www.youtube.com/watch?v={yt_id}"
