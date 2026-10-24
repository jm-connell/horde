"""AI summary, chapters, chat and related videos for streamed videos."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest
from sqlmodel import select

from app.api import stream_ai as stream_ai_api
from app.models import (
    ChannelCatalog,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
    StreamAiChatMessage,
    StreamAiState,
    VideoAiChatMessage,
    VideoAiMeta,
    utcnow,
)
from app.services import stream_ai, stream_preview, ytdlp_extract
from app.services.ai import chat as ai_chat
from app.services.ai import tasks
from app.services.auth import accounts

YT_ID = "dQw4w9WgXcQ"
URL = f"https://www.youtube.com/watch?v={YT_ID}"
CHANNEL_URL = "https://www.youtube.com/@northwind"


def _vtt(minutes: int = 12) -> str:
    lines = ["WEBVTT", ""]
    for i in range(minutes * 2):
        start = i * 30
        lines += [
            f"00:{start // 60:02d}:{start % 60:02d}.000 --> "
            f"00:{start // 60:02d}:{start % 60 + 5:02d}.000",
            f"Segment {i} talks about topic number {i} in some detail.",
            "",
        ]
    return "\n".join(lines)


class FakeLlm:
    def __init__(self, replies: list[str] | None = None):
        self.replies = list(replies or [])
        self.calls: list[dict] = []
        self.last_cost = 0.001

    def chat(self, prompt: str, model: str, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        return self.replies.pop(0) if self.replies else "{}"

    def chat_stream(self, prompt: str, model: str, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        yield "It is "
        yield "about topics."


@pytest.fixture
def stream_env(monkeypatch):
    """A captioned 12-minute stream, the LLM stubbed, and call counters."""
    seen = {"meta": 0, "vtt": 0}
    meta = {
        "id": YT_ID,
        "title": "Ridge at dawn",
        "channel": "Northwind",
        "channel_url": CHANNEL_URL,
        "description": "A ride up the ridge.",
        "duration": 720.0,
        "source_url": URL,
        "subtitles": [{"lang": "en", "auto": False}],
    }

    def fake_meta(url):
        seen["meta"] += 1
        return dict(meta)

    async def fake_vtt(request, cleaned, lang):
        seen["vtt"] += 1
        return _vtt().encode()

    monkeypatch.setattr(stream_preview, "extract_stream_preview_meta", fake_meta)
    monkeypatch.setattr(stream_ai_api, "fetch_preview_vtt", fake_vtt)
    llm = FakeLlm()
    for module in (tasks, stream_ai):
        monkeypatch.setattr(module, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(tasks, "get_llm_provider", lambda: llm)
    monkeypatch.setattr(tasks, "require_llm_chat_model", lambda *a, **k: None)
    monkeypatch.setattr(ai_chat, "get_llm_provider", lambda: llm)
    monkeypatch.setattr(ai_chat, "require_llm_chat_model", lambda *a, **k: None)
    monkeypatch.setattr(ai_chat, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(ai_chat, "ensure_quality_chat_model", lambda: "m")
    return meta, llm, seen


def _state(session) -> StreamAiState | None:
    session.expire_all()
    return session.exec(
        select(StreamAiState).where(StreamAiState.youtube_id == YT_ID)
    ).first()


def test_nothing_is_saved_until_ai_is_used(client, stream_env, session):
    read = client.get("/api/preview/ai", params={"url": URL})
    assert read.status_code == 200
    body = read.json()
    assert body["youtube_id"] == YT_ID
    assert body["supported"] is True
    assert body["summary"] is None and body["expires_at"] is None
    assert _state(session) is None


def test_a_summary_is_saved_and_reused(client, stream_env, session):
    _meta, llm, seen = stream_env
    words = " ".join(["The rider climbs the ridge at dawn."] * 40)
    llm.replies = [json.dumps({"summary": words})]

    made = client.post("/api/preview/ai/summarize", json={"url": URL})
    assert made.status_code == 200, made.text
    body = made.json()
    assert body["summary"].startswith("The rider climbs")
    assert body["has_captions"] is True
    assert body["expires_at"] is not None
    # The prompt carried the stream's own captions and metadata.
    assert "Segment 3 talks about topic number 3" in llm.calls[0]["prompt"]
    assert "Ridge at dawn" in llm.calls[0]["prompt"]
    assert llm.calls[0]["video_id"] is None

    calls = len(llm.calls)
    again = client.post("/api/preview/ai/summarize", json={"url": URL})
    assert again.json()["summary"] == body["summary"]
    assert len(llm.calls) == calls  # saved, not regenerated
    assert seen["vtt"] == 1  # captions fetched once
    assert client.get("/api/preview/ai", params={"url": URL}).json()["summary"]


def test_a_stream_without_captions_cannot_be_summarized(client, stream_env, session):
    meta, _llm, seen = stream_env
    meta["subtitles"] = []
    res = client.post("/api/preview/ai/summarize", json={"url": URL})
    assert res.status_code == 400
    assert "captions" in res.json()["detail"]
    assert seen["vtt"] == 0
    assert (
        client.get("/api/preview/ai", params={"url": URL}).json()["has_captions"]
        is False
    )


def test_chapters_are_generated_from_the_streams_captions(client, stream_env):
    _meta, llm, _seen = stream_env
    llm.replies = [
        json.dumps(
            {
                "chapters": [
                    {"start_sec": 0, "title": "Opening topics"},
                    {"start_sec": 240, "title": "Middle stretch"},
                    {"start_sec": 480, "title": "Final stretch"},
                ]
            }
        )
    ]
    res = client.post("/api/preview/ai/chapters", json={"url": URL})
    assert res.status_code == 200, res.text
    chapters = res.json()["chapters"]
    assert [c["title"] for c in chapters][:1] == ["Opening topics"]
    assert len(chapters) >= 2
    # The model saw the stream's timed captions.
    assert "Segment 8 talks about topic number 8" in llm.calls[0]["prompt"]
    again = client.get("/api/preview/ai", params={"url": URL}).json()
    assert again["chapters"] == chapters


def test_description_chapters_are_not_replaced(client, stream_env):
    meta, _llm, _seen = stream_env
    meta["description"] = "0:00 Intro\n2:00 Climb\n5:00 Summit"
    res = client.post("/api/preview/ai/chapters", json={"url": URL})
    assert res.status_code == 400
    assert "already has chapters" in res.json()["detail"]


def test_chat_is_saved_per_user_and_can_be_cleared(
    client, member_client, member_user, stream_env, session
):
    res = client.post("/api/preview/ai/chat", json={"url": URL, "message": "What?"})
    assert res.status_code == 200
    assert '"type": "done"' in res.text
    history = client.get("/api/preview/ai/chat", params={"url": URL}).json()
    assert [m["role"] for m in history["messages"]] == ["user", "assistant"]
    assert history["messages"][1]["content"] == "It is about topics."
    # Chat is per user: a member sees only their own turns, and clearing theirs
    # leaves the admin's.
    assert member_client.get("/api/preview/ai/chat", params={"url": URL}).json() == {
        "messages": []
    }
    member_client.post("/api/preview/ai/chat", json={"url": URL, "message": "Hi"})
    cleared_own = member_client.delete("/api/preview/ai/chat", params={"url": URL})
    assert cleared_own.status_code == 200
    assert (
        len(client.get("/api/preview/ai/chat", params={"url": URL}).json()["messages"])
        == 2
    )

    # Members need use_ai for stream AI, like for library AI.
    accounts.update_user(session, member_user.id, granted=[])
    assert (
        member_client.get("/api/preview/ai/chat", params={"url": URL}).status_code
        == 403
    )

    cleared = client.delete("/api/preview/ai/chat", params={"url": URL})
    assert cleared.status_code == 200
    assert client.get("/api/preview/ai/chat", params={"url": URL}).json() == {
        "messages": []
    }


def test_a_url_without_a_youtube_id_is_unsupported(client, stream_env):
    other = "https://vimeo.com/123456"
    assert client.get("/api/preview/ai", params={"url": other}).json() == {
        "youtube_id": None,
        "supported": False,
        "summary": None,
        "summary_model": None,
        "summary_cost": None,
        "chapters": [],
        "has_captions": None,
        "expires_at": None,
    }
    res = client.post("/api/preview/ai/summarize", json={"url": other})
    assert (res.status_code, res.json()["code"]) == (400, "unsupported_source")


def _saved_state(session, admin_user) -> StreamAiState:
    state = StreamAiState(
        youtube_id=YT_ID,
        source_url=URL,
        title="Ridge at dawn",
        summary="Stream summary.",
        summary_model="m",
        chapters=json.dumps([{"start_sec": 0, "title": "Start"}]),
    )
    session.add(state)
    session.commit()
    session.refresh(state)
    for role, content in (("user", "Q?"), ("assistant", "A.")):
        session.add(
            StreamAiChatMessage(
                stream_id=state.id,
                user_id=admin_user.id,
                role=role,
                content=content,
            )
        )
    session.commit()
    return state


def test_downloading_moves_the_results_onto_the_video(session, add_video, admin_user):
    _saved_state(session, admin_user)
    video = add_video(title="Ridge at dawn", yt_id=YT_ID)

    assert stream_ai.adopt_for_video(session, video)

    meta = session.get(VideoAiMeta, video.id)
    assert meta is not None and meta.summary == "Stream summary."
    assert json.loads(meta.chapters or "[]") == [{"start_sec": 0, "title": "Start"}]
    rows = session.exec(
        select(VideoAiChatMessage).where(VideoAiChatMessage.video_id == video.id)
    ).all()
    assert [(r.role, r.content, r.user_id) for r in rows] == [
        ("user", "Q?", admin_user.id),
        ("assistant", "A.", admin_user.id),
    ]
    assert _state(session) is None
    assert session.exec(select(StreamAiChatMessage)).all() == []


def test_the_videos_own_summary_wins(session, add_video, admin_user):
    _saved_state(session, admin_user)
    video = add_video(title="Ridge at dawn", yt_id=YT_ID)
    session.add(VideoAiMeta(video_id=video.id, summary="Library summary."))
    session.commit()

    assert stream_ai.adopt_downloaded(session) == 1

    session.expire_all()
    meta = session.get(VideoAiMeta, video.id)
    assert meta is not None and meta.summary == "Library summary."
    assert _state(session) is None


def test_unopened_streams_expire_and_opening_one_restarts_the_clock(
    client, session, admin_user, monkeypatch
):
    monkeypatch.setattr(stream_ai.config, "STREAM_AI_RETENTION_DAYS", 14)
    state = _saved_state(session, admin_user)
    kept = StreamAiState(youtube_id="kept1234567", source_url="", title="Kept")
    session.add(kept)
    state.last_used_at = utcnow() - timedelta(days=15)
    session.add(state)
    session.commit()

    # Opening the stream restarts its retention period.
    opened = client.get("/api/preview/ai", params={"url": URL}).json()
    assert opened["summary"] == "Stream summary."
    assert stream_ai.purge_expired(session) == 0

    assert stream_ai.purge_expired(session, now=utcnow() + timedelta(days=15)) == 2
    session.expire_all()
    assert session.exec(select(StreamAiState)).all() == []
    assert session.exec(select(StreamAiChatMessage)).all() == []


def test_related_mixes_library_and_catalog_videos(
    client, member_client, stream_env, session, add_video
):
    downloaded = add_video(title="Old ride", channel="Northwind", yt_id="libaaaaaaa1")
    add_video(title="Elsewhere", channel="Other", yt_id="libaaaaaaa2")
    catalog = ChannelCatalog(
        channel_url=CHANNEL_URL,
        channel_name="Northwind",
        status=ChannelCatalogStatus.ready,
    )
    session.add(catalog)
    session.commit()
    session.refresh(catalog)
    for pos, (yt_id, title) in enumerate(
        [
            (YT_ID, "Ridge at dawn"),  # the stream itself: never listed
            ("catbbbbbbb1", "New ride"),
            ("libaaaaaaa1", "Old ride"),  # downloaded: listed once, as downloaded
        ]
    ):
        session.add(
            ChannelCatalogVideo(
                catalog_id=catalog.id,
                yt_id=yt_id,
                url=f"https://www.youtube.com/watch?v={yt_id}",
                title=title,
                duration=600.0,
                position=pos,
            )
        )
    session.commit()

    res = member_client.get("/api/preview/related", params={"url": URL})
    assert res.status_code == 200, res.text
    items = res.json()["items"]
    assert [(i["title"], i["in_library"], i["video_id"]) for i in items] == [
        ("Old ride", True, downloaded.id),
        ("New ride", False, None),
    ]
    assert res.json()["next_cursor"] is None


def test_a_live_stream_lists_its_channels_other_live_streams_first(
    member_client, stream_env, add_video, monkeypatch
):
    meta, _llm, _seen = stream_env
    meta["is_live"] = True
    add_video(title="Old ride", channel="Northwind", yt_id="libaaaaaaa1")
    asked: list[tuple[str, str]] = []

    def streams_tab(channel_url, offset=0, limit=30, *, tab="videos"):
        asked.append((channel_url, tab))
        return {
            "entries": [
                # The stream itself and a past broadcast are not "live now".
                {
                    "id": YT_ID,
                    "url": URL,
                    "title": "[A] Ridge",
                    "live_status": "is_live",
                },
                {
                    "id": "liveBBBBBB1",
                    "url": "https://www.youtube.com/watch?v=liveBBBBBB1",
                    "title": "[B] Ridge",
                    "live_status": "is_live",
                },
                {
                    "id": "pastCCCCCC1",
                    "url": "https://www.youtube.com/watch?v=pastCCCCCC1",
                    "title": "Yesterday",
                    "live_status": "was_live",
                },
            ]
        }

    monkeypatch.setattr(ytdlp_extract, "fetch_channel_feed", streams_tab)
    res = member_client.get("/api/preview/related", params={"url": URL})
    assert res.status_code == 200, res.text
    items = res.json()["items"]
    assert [(i["title"], i["live_status"]) for i in items] == [
        ("[B] Ridge", "is_live"),
        ("Old ride", None),
    ]
    assert asked == [(CHANNEL_URL, "streams")]

    # A stream that is not live does not look for live siblings.
    meta["is_live"] = False
    asked.clear()
    member_client.get("/api/preview/related", params={"url": URL})
    assert asked == []


def test_a_caption_track_that_is_gone_is_remembered(client, stream_env, monkeypatch):
    from fastapi import HTTPException

    _meta, _llm, seen = stream_env

    async def missing(request, cleaned, lang):
        seen["vtt"] += 1
        raise HTTPException(status_code=404, detail="no track")

    monkeypatch.setattr(stream_ai_api, "fetch_preview_vtt", missing)
    first = client.post("/api/preview/ai/summarize", json={"url": URL})
    assert (first.status_code, first.json()["code"]) == (400, "no_captions")
    client.post("/api/preview/ai/summarize", json={"url": URL})
    assert seen["vtt"] == 1  # not asked again


def test_a_passing_caption_failure_is_retried(client, stream_env, monkeypatch):
    from fastapi import HTTPException

    _meta, llm, seen = stream_env

    async def flaky(request, cleaned, lang):
        seen["vtt"] += 1
        raise HTTPException(status_code=502, detail="upstream")

    monkeypatch.setattr(stream_ai_api, "fetch_preview_vtt", flaky)
    first = client.post("/api/preview/ai/summarize", json={"url": URL})
    assert (first.status_code, first.json()["code"]) == (502, "captions_unavailable")
    assert llm.calls == []
    client.post("/api/preview/ai/summarize", json={"url": URL})
    assert seen["vtt"] == 2  # tried again


def test_ai_that_is_off_does_no_network_work(client, stream_env, monkeypatch):
    _meta, _llm, seen = stream_env
    monkeypatch.setattr(stream_ai, "llm_features_allowed", lambda: (False, "AI off"))
    res = client.post("/api/preview/ai/summarize", json={"url": URL})
    assert (res.status_code, res.json()["code"]) == (400, "ai_disabled")
    chat = client.post("/api/preview/ai/chat", json={"url": URL, "message": "Hi"})
    assert chat.status_code == 400
    assert seen == {"meta": 0, "vtt": 0}


def test_a_saved_stream_is_not_read_again(client, stream_env):
    _meta, llm, seen = stream_env
    llm.replies = [json.dumps({"summary": " ".join(["Word"] * 200)})]
    client.post("/api/preview/ai/summarize", json={"url": URL})
    client.post("/api/preview/ai/chat", json={"url": URL, "message": "Hi"})
    assert seen == {"meta": 1, "vtt": 1}


def test_two_first_requests_share_one_row(session, monkeypatch):
    """The loser of the insert race re-reads the winner's row."""
    real = stream_ai.find_state
    calls = {"n": 0}

    def racing(sess, youtube_id):
        calls["n"] += 1
        if calls["n"] == 1:
            # Another request inserts between our lookup and our insert.
            sess.add(StreamAiState(youtube_id=youtube_id, title="Theirs"))
            sess.commit()
            return None
        return real(sess, youtube_id)

    monkeypatch.setattr(stream_ai, "find_state", racing)
    state = stream_ai.upsert_state(session, YT_ID, {"title": "Ours"})
    assert state.title == "Ours"
    session.expire_all()
    assert len(session.exec(select(StreamAiState)).all()) == 1


def test_a_download_during_the_summary_keeps_it(
    session, add_video, stream_env, monkeypatch
):
    state = stream_ai.upsert_state(session, YT_ID, stream_env[0])
    stream_ai.store_captions(session, state, _vtt())
    real = stream_ai.generate_summary

    def download_meanwhile(*args, **kwargs):
        result = real(*args, **kwargs)
        video = add_video(title="Ridge at dawn", yt_id=YT_ID)
        stream_ai.adopt_for_video(session, video)
        return result

    stream_env[1].replies = [json.dumps({"summary": " ".join(["Word"] * 200)})]
    monkeypatch.setattr(stream_ai, "generate_summary", download_meanwhile)
    text = stream_ai.summarize(session, state)
    video_id = session.exec(select(VideoAiMeta.video_id)).one()
    meta = session.get(VideoAiMeta, video_id)
    assert meta is not None and meta.summary == text


def test_a_download_during_a_chat_reply_says_so(
    session, add_video, admin_user, stream_env
):
    state = stream_ai.upsert_state(session, YT_ID, stream_env[0])
    llm = stream_env[1]

    def reply_then_download(prompt, model, **kwargs):
        yield "Partial "
        video = add_video(title="Ridge at dawn", yt_id=YT_ID)
        stream_ai.adopt_for_video(session, video)
        yield "reply."

    llm.chat_stream = reply_then_download
    events = list(stream_ai.stream_chat_events(state.id, YT_ID, "Hi", admin_user.id))
    assert '"status": 409' in events[-1]
    assert "downloaded" in events[-1]


def test_finalize_and_the_sweep_adopt(session, add_video, admin_user, monkeypatch):
    _saved_state(session, admin_user)
    video = add_video(title="Ridge at dawn", yt_id=YT_ID)
    assert stream_ai.adopt_video_id(video.id)
    session.expire_all()
    assert _state(session) is None

    # A video that reached the library another way is adopted by the sweep.
    other = StreamAiState(youtube_id="libaaaaaaa9", title="Imported")
    session.add(other)
    session.commit()
    add_video(title="Imported", yt_id="libaaaaaaa9")
    stream_ai.sweep()
    session.expire_all()
    assert session.exec(select(StreamAiState)).all() == []
