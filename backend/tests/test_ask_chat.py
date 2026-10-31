"""Ask chat: routing, retrieval, references with exact moments, saved threads."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from sqlmodel import Session, select

from app.models import (
    AskMessage,
    AskThread,
    KbChannel,
    KbChannelStatus,
    KbChunk,
    KbVideo,
)
from app.services.ai import chat, help_chat, help_model
from app.services.knowledge import (
    ask_chat,
    captions,
    embed,
    indexing,
    references,
    retrieval,
    routing,
    vectors,
)
from app.services.knowledge.retrieval import Excerpt


def _events(text: str) -> list[dict]:
    return [
        json.loads(line[5:])
        for line in text.splitlines()
        if line.startswith("data:") and line[5:].strip()
    ]


def _vtt(lines: dict[int, str], seconds: int = 120) -> str:
    out = ["WEBVTT", ""]
    for s in range(0, seconds, 3):
        out += [
            f"00:{s // 60:02d}:{s % 60:02d}.000 --> 00:{(s + 3) // 60:02d}:{(s + 3) % 60:02d}.000",
            lines.get(s, f"filler words {s}"),
            "",
        ]
    return "\n".join(out)


def _channel(
    session: Session, name="The Car Care Nut", url="https://youtube.com/@thecarcarenut"
):
    channel = KbChannel(
        channel_url=url, channel_name=name, status=KbChannelStatus.ready
    )
    session.add(channel)
    session.commit()
    session.refresh(channel)
    return channel


def _indexed_video(
    session: Session, channel: KbChannel, yt_id: str, vtt: str, **fields
):
    assert channel.id is not None
    video = KbVideo(kb_channel_id=channel.id, yt_id=yt_id, **fields)
    session.add(video)
    session.commit()
    session.refresh(video)
    indexing.apply_result(
        session, video, captions.CaptionResult(captions.FETCHED, vtt=vtt)
    )
    return video


# --- routing -------------------------------------------------------------------


@pytest.mark.parametrize(
    "message",
    [
        "What does the Car Care Nut say about the 2004 4Runner?",
        "what does car care nut's video say",
        "Ask @TheCarCareNut about belts",
        "carcarenut on oil changes",
        "CarCareNut on oil changes",
    ],
)
def test_named_channels_finds_the_channel(message):
    channel = KbChannel(
        id=1,
        channel_url="https://youtube.com/@thecarcarenut",
        channel_name="The Car Care Nut",
    )
    other = KbChannel(
        id=2,
        channel_url="https://youtube.com/@linustechtips",
        channel_name="Linus Tech Tips",
    )
    assert routing.named_channels(message, [channel, other]) == [channel]


def test_named_channels_ignores_unrelated_questions():
    channel = KbChannel(
        id=1,
        channel_url="https://youtube.com/@thecarcarenut",
        channel_name="The Car Care Nut",
    )
    assert (
        routing.named_channels("How do I set up subtitles in Horde?", [channel]) == []
    )
    assert routing.named_channels("the nut came loose", [channel]) == []


def test_named_channels_finds_several():
    a = KbChannel(
        id=1, channel_url="https://youtube.com/@a", channel_name="The Car Care Nut"
    )
    b = KbChannel(id=2, channel_url="https://youtube.com/@b", channel_name="ChrisFix")
    found = routing.named_channels(
        "Do ChrisFix and the car care nut agree on oil?", [a, b]
    )
    assert found == [a, b]


def test_asks_all_channels():
    assert routing.asks_all_channels("What do all my channels say about oil?")
    assert routing.asks_all_channels("does any channel cover this")
    assert not routing.asks_all_channels("what does Linus say")


# --- references ------------------------------------------------------------------


def _excerpt(n: int, chunk_id: int, start: float, end: float, **kw) -> Excerpt:
    return Excerpt(
        n=n,
        chunk_id=chunk_id,
        channel_id=1,
        channel_name="The Car Care Nut",
        yt_id=kw.pop("yt_id", "abcdefghijk"),
        title="Belts",
        published_at="2021-05-01T00:00:00Z",
        start_sec=start,
        end_sec=end,
        text="…",
        is_description=kw.pop("is_description", False),
        kb_video_id=7,
        **kw,
    )


LINES = [
    (0.0, "welcome back"),
    (30.0, "the timing belt lasts ninety thousand"),
    (60.0, "water pump goes with it"),
]


def test_references_renumber_drop_invented_and_find_the_moment():
    excerpts = [_excerpt(4, 40, 0.0, 75.0), _excerpt(9, 90, 60.0, 135.0)]
    reply = (
        "He says the timing belt lasts ninety thousand miles [9][4]. "
        "Replace the water pump with it [4]. Something else [12]."
    )
    content, refs = references.resolve(reply, excerpts, lambda _vid: LINES)
    # Excerpt 9 is cited first but its passage (60s on) does not mention the belt.
    assert content == (
        "He says the timing belt lasts ninety thousand miles[1][2]. "
        "Replace the water pump with it[3]. Something else."
    )
    assert [r.n for r in refs] == [1, 2, 3]
    assert refs[0].start_sec == 60.0  # excerpt 9: nothing better than its start
    assert refs[1].start_sec == pytest.approx(28.0)  # the belt line, 2 s early
    assert refs[1].line == "the timing belt lasts ninety thousand"
    assert refs[2].start_sec == pytest.approx(58.0)  # same excerpt, another moment


def test_references_handle_lists_and_descriptions():
    excerpts = [
        _excerpt(1, 10, 0.0, 0.0, is_description=True),
        _excerpt(2, 20, 0.0, 75.0),
    ]
    content, refs = references.resolve(
        "See the parts list [1, 2].", excerpts, lambda _v: LINES
    )
    assert content == "See the parts list[1][2]."
    assert refs[0].is_description and refs[0].line == ""


# --- chat ----------------------------------------------------------------------------


@pytest.fixture
def llm(monkeypatch, app):
    """A stub chat model: streams ``replies`` in turn; expansion returns ``expand``."""
    state: dict = {"replies": [], "calls": [], "expand": {"terms": [], "search": ""}}

    class Provider:
        last_cost = 0.001

        def chat_stream(self, prompt, model, **kwargs):
            state["calls"].append({"prompt": prompt, "model": model, **kwargs})
            yield state["replies"].pop(0)

        def chat(self, prompt, model, **kwargs):
            state.setdefault("expansions", []).append(prompt)
            return json.dumps(state["expand"])

    for module in (chat, ask_chat):
        monkeypatch.setattr(module, "get_llm_provider", lambda: Provider())
        monkeypatch.setattr(module, "require_llm_chat_model", lambda *_: None)
    monkeypatch.setattr(ask_chat, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(help_model, "assistant_model", lambda: "test-model-14b")
    monkeypatch.setattr(retrieval, "embed_query", lambda q: None)
    return state


BELT_VTT = _vtt(
    {30: "the timing belt on the 4.7 lasts ninety thousand miles", 33: "so do it then"}
)


def test_a_named_channel_answers_with_references(client, session, llm):
    channel = _channel(session)
    _indexed_video(
        session,
        channel,
        "aaaaaaaaaaa",
        BELT_VTT,
        title="Maintenance",
        published_at="2020-01-01T00:00:00Z",
    )
    llm["replies"] = [
        "He says the timing belt lasts ninety thousand miles [1]. Also [5]."
    ]
    r = client.post(
        "/api/ask/chat",
        json={"message": "When does the Car Care Nut say to change the timing belt?"},
    )
    assert r.status_code == 200, r.text
    events = _events(r.text)
    kinds = [e["type"] for e in events]
    assert kinds[:3] == ["thread", "scope", "status"]
    assert kinds[-2:] == ["references", "done"]
    assert events[1]["channels"] == [{"id": channel.id, "name": "The Car Care Nut"}]
    done = events[-1]["message"]
    assert (
        done["content"]
        == "He says the timing belt lasts ninety thousand miles[1]. Also."
    )
    [ref] = events[-2]["references"]
    assert ref["yt_id"] == "aaaaaaaaaaa"
    assert ref["start_sec"] == pytest.approx(28.0, abs=3)
    assert "timing belt" in ref["line"]
    # The model saw numbered excerpts without times, and the citation rules.
    call = llm["calls"][0]
    assert "[1] The Car Care Nut" in call["system"]
    assert "Never write times" in call["system"]
    assert "0:30" not in call["system"]

    thread = client.get(f"/api/ask/threads/{events[0]['id']}").json()
    assert [m["role"] for m in thread["messages"]] == ["user", "assistant"]
    saved = thread["messages"][1]
    assert saved["sources"]["kind"] == "channels"
    assert saved["sources"]["references"][0]["start_sec"] == ref["start_sec"]
    assert thread["scope"] == {
        "channels": [{"id": channel.id, "name": "The Car Care Nut"}]
    }


def test_query_expansion_finds_caption_spellings(client, session, llm):
    channel = _channel(session)
    _indexed_video(
        session, channel, "aaaaaaaaaaa", _vtt({45: "the for runner frame rusts"})
    )
    llm["expand"] = {
        "terms": ["4Runner", "for runner", "frame rust"],
        "search": "4Runner frame rust",
    }
    llm["replies"] = ["The frame rusts [1]."]
    events = _events(
        client.post(
            "/api/ask/chat", json={"message": "car care nut on the 4Runner?"}
        ).text
    )
    assert events[-1]["type"] == "done"
    assert events[-2]["references"][0]["start_sec"] == pytest.approx(43.0, abs=3)


def test_follow_ups_keep_the_channel_without_naming_it(client, session, llm):
    channel = _channel(session)
    _indexed_video(session, channel, "aaaaaaaaaaa", BELT_VTT)
    llm["replies"] = ["First [1].", "Second [1]."]
    first = _events(
        client.post("/api/ask/chat", json={"message": "car care nut timing belt?"}).text
    )
    thread_id = first[0]["id"]
    second = _events(
        client.post(
            "/api/ask/chat",
            json={
                "message": "and the timing belt again?",
                "thread_id": thread_id,
                "channel_ids": [channel.id],
            },
        ).text
    )
    assert second[0]["id"] == thread_id
    assert second[1]["channels"][0]["id"] == channel.id
    # The second prompt carried the first turn as history.
    assert llm["calls"][1]["messages"][0]["content"] == "car care nut timing belt?"


def test_nothing_found_answers_without_the_model(client, session, llm):
    channel = _channel(session)
    _indexed_video(session, channel, "aaaaaaaaaaa", BELT_VTT)
    events = _events(
        client.post(
            "/api/ask/chat", json={"message": "car care nut on quantum chromodynamics?"}
        ).text
    )
    assert events[-1]["type"] == "done"
    assert "couldn't find" in events[-1]["message"]["content"]
    assert llm["calls"] == []


@pytest.fixture
def help_index(tmp_path: Path, tmp_dirs, monkeypatch):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "features.md").write_text(
        "# Features\n\nHorde downloads videos.\n"
    )
    (tmp_path / "docs" / "subs.md").write_text(
        "# Subtitles\n\nTurn subtitles on in the player.\n"
    )
    index = help_chat.HelpIndex(tmp_path)
    index.ensure_built()
    monkeypatch.setattr(help_chat, "help_index", lambda: index)
    monkeypatch.setattr(help_chat, "llm_features_allowed", lambda: (True, None))
    return index


def test_unnamed_questions_go_to_ask_about_horde_and_are_saved(
    client, session, llm, help_index
):
    _indexed_video(session, _channel(session), "aaaaaaaaaaa", BELT_VTT)
    llm["replies"] = ["Use the player menu."]
    events = _events(
        client.post(
            "/api/ask/chat", json={"message": "How do I turn on subtitles?"}
        ).text
    )
    kinds = [e["type"] for e in events]
    assert kinds[:2] == ["thread", "scope"] and events[1]["channels"] == []
    assert "sources" in kinds and kinds[-1] == "done"
    thread = client.get(f"/api/ask/threads/{events[0]['id']}").json()
    assert thread["scope"] == {"help": True}
    assert [m["content"] for m in thread["messages"]] == [
        "How do I turn on subtitles?",
        "Use the player menu.",
    ]
    assert thread["messages"][1]["sources"]["kind"] == "help"


def test_threads_are_private_listed_and_deletable(
    client, member_client, session, llm, help_index
):
    llm["replies"] = ["Hi."]
    events = _events(client.post("/api/ask/chat", json={"message": "hello there"}).text)
    thread_id = events[0]["id"]
    assert [t["id"] for t in client.get("/api/ask/threads").json()["items"]] == [
        thread_id
    ]
    assert member_client.get("/api/ask/threads").json()["items"] == []
    assert member_client.get(f"/api/ask/threads/{thread_id}").status_code == 404
    other = member_client.post(
        "/api/ask/chat", json={"message": "x", "thread_id": thread_id}
    )
    assert other.status_code == 404
    assert member_client.delete(f"/api/ask/threads/{thread_id}").status_code == 404
    assert client.delete(f"/api/ask/threads/{thread_id}").status_code == 204
    assert session.exec(select(AskThread)).all() == []
    assert session.exec(select(AskMessage)).all() == []


def test_members_do_not_see_model_or_cost(member_client, session, llm, help_index):
    llm["replies"] = ["Hi."]
    events = _events(
        member_client.post("/api/ask/chat", json={"message": "hello"}).text
    )
    saved = member_client.get(f"/api/ask/threads/{events[0]['id']}").json()["messages"][
        1
    ]
    assert saved["model"] is None and saved["cost"] is None


# --- embeddings ---------------------------------------------------------------------


def test_embedding_batches_and_vector_search(session, init_db, monkeypatch):
    channel = _channel(session)
    _indexed_video(session, channel, "aaaaaaaaaaa", BELT_VTT)
    _indexed_video(session, channel, "bbbbbbbbbbb", _vtt({}, 30))

    class Provider:
        def embed_many(self, texts, model, **kwargs):
            return [
                [1.0, 0.0, 0.0] if "timing belt" in t else [0.0, 1.0, 0.0]
                for t in texts
            ]

    monkeypatch.setattr(embed, "get_embed_provider", lambda: Provider())
    monkeypatch.setattr(embed, "resolve_embed_model", lambda *_: "emb")
    enqueued: list[int] = []
    monkeypatch.setattr(
        embed, "_enqueue", lambda cid, force=False: enqueued.append(cid)
    )
    monkeypatch.setattr(embed, "BATCH_VIDEOS", 1)
    assert channel.id is not None
    assert embed.embed_channel_batch(session, channel.id) is None
    assert enqueued == [channel.id]  # one video left: the next batch is queued
    assert embed.embed_channel_batch(session, channel.id) is None
    session.refresh(channel)
    assert (channel.embed_model, channel.embed_dim) == ("emb", 3)
    assert all(v.embedded_model == "emb" for v in session.exec(select(KbVideo)))

    cache = init_db["ctx"].knowledge.vectors
    hits = vectors.top_chunks(session, cache, channel, [1.0, 0.0, 0.0], 3, model="emb")
    assert hits and hits[0][1] == pytest.approx(1.0, abs=1e-3)
    # A new embedding model: old vectors are left out until re-embedded.
    monkeypatch.setattr(embed, "resolve_embed_model", lambda *_: "emb2")
    embed.embed_channel_batch(session, channel.id)
    session.refresh(channel)
    assert channel.embed_model == "emb2"
    found = vectors.top_chunks(
        session, cache, channel, [1.0, 0.0, 0.0], 50, model="emb2"
    )
    embedded = {
        c.id
        for v in session.exec(select(KbVideo).where(KbVideo.embedded_model == "emb2"))
        for c in session.exec(select(KbChunk).where(KbChunk.kb_video_id == v.id))
    }
    assert {c for c, _ in found} <= embedded


def test_vectors_are_float16():
    assert np.frombuffer(embed.pack([0.5, 0.25]), dtype=np.float16).tolist() == [
        0.5,
        0.25,
    ]


def test_all_channels_picks_the_most_relevant(session):
    belt = _channel(session, "Belt Channel", "https://youtube.com/@belt")
    other = _channel(session, "Other Channel", "https://youtube.com/@other")
    _indexed_video(session, belt, "aaaaaaaaaaa", BELT_VTT)
    _indexed_video(session, other, "bbbbbbbbbbb", _vtt({}, 30))
    assert ask_chat.pick_scope(
        session, "what do all my channels say about belts?", None
    ) == [
        belt,
        other,
    ]
    assert ask_chat.most_relevant(session, [other, belt], "timing belt", 1) == [belt]


def test_two_named_channels_are_compared_from_both(client, session, llm):
    nut = _channel(session)
    fix = _channel(session, "ChrisFix", "https://youtube.com/@chrisfix")
    _indexed_video(session, nut, "aaaaaaaaaaa", BELT_VTT)
    _indexed_video(
        session, fix, "bbbbbbbbbbb", _vtt({60: "i never change the timing belt early"})
    )
    llm["replies"] = ["They disagree [1][2]."]
    events = _events(
        client.post(
            "/api/ask/chat",
            json={
                "message": "Do ChrisFix and the Car Care Nut agree on the timing belt?"
            },
        ).text
    )
    assert {c["name"] for c in events[1]["channels"]} == {
        "ChrisFix",
        "The Car Care Nut",
    }
    system = llm["calls"][0]["system"]
    assert "ChrisFix ·" in system and "The Car Care Nut ·" in system
    assert "where they agree and where they disagree" in system
    assert {r["channel"] for r in events[-2]["references"]} == {
        "ChrisFix",
        "The Car Care Nut",
    }


def test_references_leave_code_and_glued_numbers_alone():
    excerpts = [_excerpt(1, 10, 0.0, 75.0), _excerpt(5, 50, 0.0, 75.0)]
    reply = "Use `arr[1]` and items[7] here [1][5]. Made up [9]."
    content, refs = references.resolve(reply, excerpts, lambda _v: LINES)
    assert content == "Use `arr[1]` and items[7] here[1][2]. Made up."
    assert [r.n for r in refs] == [1, 2]


# --- review regressions ----------------------------------------------------------


def test_one_failing_video_does_not_block_the_channel(session, monkeypatch):
    channel = _channel(session)
    bad = _indexed_video(session, channel, "aaaaaaaaaaa", BELT_VTT, position=0)
    good = _indexed_video(session, channel, "bbbbbbbbbbb", BELT_VTT, position=1)

    calls: list[int] = []

    class Picky:
        def embed_many(self, texts, model, **kwargs):
            calls.append(len(texts))
            if len(calls) == 1:
                raise RuntimeError("this video always fails")
            return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(embed, "get_embed_provider", lambda: Picky())
    monkeypatch.setattr(embed, "resolve_embed_model", lambda *_: "emb")
    monkeypatch.setattr(embed, "_enqueue", lambda cid, force=False: None)
    assert channel.id is not None
    assert embed.embed_channel_batch(session, channel.id) is None
    session.refresh(bad)
    session.refresh(good)
    assert good.embedded_model == "emb"
    assert bad.embedded_model == "failed:emb"  # skipped until the model changes
    assert not embed._has_work(session, channel.id, "emb")
    assert embed._has_work(session, channel.id, "emb2")


def test_a_batch_where_nothing_works_fails_and_waits(session, monkeypatch, init_db):
    from app.models import AiJob, AiJobKind, AiJobStatus

    channel = _channel(session)
    _indexed_video(session, channel, "aaaaaaaaaaa", BELT_VTT)

    class Down:
        def embed_many(self, texts, model, **kwargs):
            raise RuntimeError("provider down")

    monkeypatch.setattr(embed, "get_embed_provider", lambda: Down())
    monkeypatch.setattr(embed, "resolve_embed_model", lambda *_: "emb")
    monkeypatch.setattr(embed, "embeddings_configured", lambda: True)
    assert channel.id is not None
    with pytest.raises(RuntimeError):
        embed.embed_channel_batch(session, channel.id)
    session.add(
        AiJob(
            kind=AiJobKind.embed_kb_channel,
            kb_channel_id=channel.id,
            status=AiJobStatus.error,
        )
    )
    session.commit()
    assert embed.ensure_jobs() == 0  # backs off instead of retrying at once


def test_non_object_expansion_falls_back(monkeypatch):
    class Provider:
        last_cost = None

        def chat(self, *a, **k):
            return '["timing belt", "4.7"]'

    assert retrieval.expand(Provider(), "m", "q", ["c"]) == retrieval.Expansion()


def test_a_crash_while_answering_is_an_error_event(client, session, llm, monkeypatch):
    _indexed_video(session, _channel(session), "aaaaaaaaaaa", BELT_VTT)

    def boom(*a, **k):
        raise RuntimeError("bug")

    monkeypatch.setattr(retrieval, "retrieve", boom)
    events = _events(
        client.post("/api/ask/chat", json={"message": "car care nut belt?"}).text
    )
    assert events[-1]["type"] == "error"
    # The conversation it started holds nothing, so it is gone again.
    assert session.exec(select(AskThread)).all() == []


def test_members_see_no_model_or_cost_in_the_stream(member_client, session, llm):
    _indexed_video(session, _channel(session), "aaaaaaaaaaa", BELT_VTT)
    llm["replies"] = ["Change it [1]."]
    events = _events(
        member_client.post("/api/ask/chat", json={"message": "car care nut belt?"}).text
    )
    done = events[-1]
    assert done["type"] == "done"
    assert "model" not in done and "cost" not in done
    assert "model" not in done["message"] and "cost" not in done["message"]


def test_old_model_vectors_are_not_compared_with_a_new_query(
    session, init_db, monkeypatch
):
    channel = _channel(session)
    _indexed_video(session, channel, "aaaaaaaaaaa", BELT_VTT)

    class Provider:
        def embed_many(self, texts, model, **kwargs):
            return [[1.0, 0.0, 0.0] for _ in texts]

    monkeypatch.setattr(embed, "get_embed_provider", lambda: Provider())
    monkeypatch.setattr(embed, "resolve_embed_model", lambda *_: "old")
    monkeypatch.setattr(embed, "_enqueue", lambda cid, force=False: None)
    assert channel.id is not None
    embed.embed_channel_batch(session, channel.id)
    session.refresh(channel)
    cache = init_db["ctx"].knowledge.vectors
    assert vectors.top_chunks(session, cache, channel, [1.0, 0.0, 0.0], 3, model="old")
    assert (
        vectors.top_chunks(session, cache, channel, [1.0, 0.0, 0.0], 3, model="new")
        == []
    )


def test_library_ai_jobs_go_before_a_window_of_ask_jobs(session, add_video):
    from datetime import timedelta

    from app.models import AiJob, AiJobKind, utcnow
    from app.services.ai import worker as ai_worker

    old = utcnow() - timedelta(hours=1)
    for i in range(40):
        channel = _channel(session, f"Channel {i}", f"https://youtube.com/@c{i}")
        session.add(
            AiJob(
                kind=AiJobKind.embed_kb_channel,
                kb_channel_id=channel.id,
                created_at=old,
            )
        )
    video = add_video()
    session.add(AiJob(kind=AiJobKind.embed_video, video_id=video.id))
    session.commit()
    job = ai_worker._next_job(session, llm_ok=True, embed_ok=True)
    assert job is not None and job.kind == AiJobKind.embed_video
