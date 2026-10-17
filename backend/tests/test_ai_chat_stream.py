"""AI chat streaming when the caller goes away mid-answer."""

from __future__ import annotations

import logging

import pytest
from sqlmodel import select

from app.models import OpenRouterUsage, VideoAiChatMessage
from app.services.ai import chat, cost_ledger
from app.services.auth import accounts


@pytest.fixture
def chat_env(monkeypatch, add_video, session, admin_user):
    """A chat-able video and a user, with the provider and its helpers stubbed."""
    user = accounts.create_user(session, "chatter", "chatter-password")
    video = add_video(title="A video", description="About things")
    monkeypatch.setattr(chat, "ensure_quality_chat_model", lambda: "m")
    monkeypatch.setattr(chat, "require_llm_chat_model", lambda *_: None)
    monkeypatch.setattr(chat, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(chat.ai_embeddings, "build_chat_context", lambda *_: "")

    def use(provider) -> None:
        monkeypatch.setattr(chat, "get_llm_provider", lambda: provider)

    return user, video, use


def _assistant_rows(session) -> list[VideoAiChatMessage]:
    session.expire_all()
    return list(
        session.exec(
            select(VideoAiChatMessage).where(VideoAiChatMessage.role == "assistant")
        )
    )


def test_chat_stream_stops_when_the_caller_is_revoked(chat_env, session):
    """The reply is neither streamed on nor stored once access is gone."""
    user, video, use = chat_env

    class Provider:
        last_cost = None

        def chat_stream(self, *_a, **_k):
            yield "hello "
            yield "world"

    use(Provider())
    allowed = iter([True, False])
    events = list(
        chat.stream_chat_events(
            video.id, "hi", user.id, lambda force=False: next(allowed, False)
        )
    )

    assert '"type": "token"' in events[1]
    assert '"status": 401' in events[-1]
    assert not any('"type": "done"' in e for e in events)
    assert _assistant_rows(session) == []


def test_chat_survives_the_user_being_deleted_mid_answer(chat_env, session, caplog):
    """Deleting the account while the model answers is an error event, not a crash."""
    user, video, use = chat_env

    class Provider:
        last_cost = None

        def chat_stream(self, *_a, **_k):
            yield "hello "
            from sqlmodel import Session

            from app.context import get_engine

            with Session(get_engine()) as other:
                accounts.delete_user(other, user.id)
            yield "world"
            # What OpenRouterProvider does once the usage chunk has arrived.
            self.last_cost = cost_ledger.record_cost(
                cost=0.002, kind="chat", model="m", video_id=video.id
            )

    use(Provider())
    with caplog.at_level(logging.WARNING, logger="app.services.ai.chat"):
        events = list(chat.stream_chat_events(video.id, "hi", user.id))

    assert '"type": "error"' in events[-1]
    assert not any('"type": "done"' in e for e in events)
    assert "no longer exists" in caplog.text
    assert _assistant_rows(session) == []
    # The spend was booked exactly once, and nothing was left half-written.
    session.expire_all()
    rows = list(session.exec(select(OpenRouterUsage)))
    assert [r.cost for r in rows] == [0.002]


URL = "http://gpu-box.internal:11434/api/chat"


def _status_error() -> Exception:
    import httpx

    request = httpx.Request("POST", URL)
    response = httpx.Response(500, request=request)
    return httpx.HTTPStatusError(
        f"Server error '500' for url '{URL}'", request=request, response=response
    )


def test_chat_error_event_does_not_quote_the_provider_url(chat_env):
    user, video, use = chat_env

    class Provider:
        last_cost = None

        def chat_stream(self, *_a, **_k):
            raise _status_error()
            yield ""  # pragma: no cover - makes this a generator

    use(Provider())
    events = list(chat.stream_chat_events(video.id, "hi", user.id))

    body = "".join(events)
    assert '"type": "error"' in events[-1]
    assert "gpu-box" not in body and "11434" not in body
    assert "AI provider HTTP 500" in events[-1]


@pytest.mark.parametrize("route", ["summarize", "chapters"])
def test_ai_routes_do_not_quote_the_provider_url(client, add_video, monkeypatch, route):
    from app.services.ai import tasks

    video = add_video(title="A video", description="About things")

    def boom(*_a, **_k):
        raise _status_error()

    monkeypatch.setattr(
        tasks, "run_summarize" if route == "summarize" else "run_chapters", boom
    )

    resp = client.post(f"/api/videos/{video.id}/ai/{route}")

    assert resp.status_code == 502
    assert "gpu-box" not in resp.text and "11434" not in resp.text


def test_a_revoked_chat_stops_reading_the_provider(chat_env, session):
    """Closing the provider stream drops the upstream request instead of draining it."""
    user, video, use = chat_env
    state = {"closed": False, "yielded": 0}

    class Provider:
        last_cost = None

        def chat_stream(self, *_a, **_k):
            try:
                for word in ("a ", "b ", "c ", "d "):
                    state["yielded"] += 1
                    yield word
            finally:
                state["closed"] = True

    use(Provider())
    allowed = iter([True, False])
    list(
        chat.stream_chat_events(
            video.id, "hi", user.id, lambda force=False: next(allowed, False)
        )
    )

    assert state == {"closed": True, "yielded": 2}


def test_chat_route_ends_the_stream_when_the_member_is_disabled_midway(
    app, member_client, member_user, init_db, chat_env, session
):
    """The real route wires the auth guard into the chat generator."""
    from sqlmodel import Session

    _user, video, use = chat_env
    app.state.auth.stream_recheck_seconds = 0.0

    class Provider:
        last_cost = None

        def chat_stream(self, *_a, **_k):
            yield "hello "
            with Session(init_db["engine"]) as other:
                accounts.update_user(other, member_user.id, disabled=True)
            yield "world "
            yield "never sent"

    use(Provider())
    resp = member_client.post(f"/api/videos/{video.id}/ai/chat", json={"message": "hi"})

    assert resp.status_code == 200
    assert '"text": "hello "' in resp.text
    assert '"status": 401' in resp.text
    assert "never sent" not in resp.text
    assert '"type": "done"' not in resp.text
