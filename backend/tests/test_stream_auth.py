"""Open event streams end when their caller loses access (disable, delete, reset)."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

import pytest
from sqlmodel import Session

from app.auth import STREAM_KEEPALIVE
from app.models import DownloadJob, JobStatus
from app.services.auth import accounts
from tests.conftest import _client, _session_cookie

# Short enough that the suite stays fast, long enough to read some keepalives.
_RECHECK = 0.05


@pytest.fixture
def fast_recheck(app):
    app.state.auth.stream_recheck_seconds = _RECHECK


def _stop_streams(app) -> None:
    """Ends any stream still open (the app's shutdown signal)."""
    event = getattr(app.state, "shutdown_event", None) or threading.Event()
    app.state.shutdown_event = event
    event.set()


def _read_stream(client, url: str, lines: list[str], done: threading.Event) -> None:
    with client.stream("GET", url) as response:
        for line in response.iter_lines():
            lines.append(line)
    done.set()


def _assert_stream_ends_after(
    member_client, url: str, revoke: Callable[[], None]
) -> None:
    lines: list[str] = []
    done = threading.Event()
    reader = threading.Thread(
        target=_read_stream, args=(member_client, url, lines, done), daemon=True
    )
    reader.start()
    try:
        time.sleep(0.4)
        assert not done.is_set(), "the stream ended before access was revoked"
        revoke()
        assert done.wait(5), "the stream outlived the revoked account"
    finally:
        _stop_streams(member_client.app)
        reader.join(5)


def _revoke_with(init_db, member_user, **changes) -> Callable[[], None]:
    def revoke() -> None:
        with Session(init_db["engine"]) as s:
            accounts.update_user(s, member_user.id, **changes)

    return revoke


@pytest.fixture
def running_job(session, monkeypatch) -> DownloadJob:
    from app.services.downloads import progress

    # Other tests leave snapshots (some "completed") in the process-wide store.
    monkeypatch.setattr(progress, "progress_store", {})
    job = DownloadJob(url="https://example.com/v", status=JobStatus.downloading)
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def test_keepalive_constant_is_an_sse_comment():
    assert STREAM_KEEPALIVE == ": keepalive\n\n"


@pytest.mark.parametrize("which", ["queue", "job"])
@pytest.mark.parametrize("change", ["disable", "password", "delete", "logout"])
def test_download_streams_end_when_access_is_revoked(
    which, change, fast_recheck, member_client, member_user, init_db, running_job
):
    url = (
        "/api/downloads/events"
        if which == "queue"
        else f"/api/downloads/{running_job.id}/events"
    )
    if change == "disable":
        revoke = _revoke_with(init_db, member_user, disabled=True)
    elif change == "password":
        revoke = _revoke_with(init_db, member_user, password="a-new-password-1")
    elif change == "delete":

        def revoke() -> None:
            with Session(init_db["engine"]) as s:
                accounts.delete_user(s, member_user.id)

    else:

        def revoke() -> None:
            with Session(init_db["engine"]) as s:
                accounts.end_session(s, member_client.cookies[accounts.SESSION_COOKIE])

    _assert_stream_ends_after(member_client, url, revoke)


def test_stream_stays_open_while_access_holds(
    fast_recheck, app, member_user, init_db, running_job, monkeypatch
):
    from app.auth import StreamAuthGuard

    rechecked = threading.Event()
    results: list[bool] = []
    real = StreamAuthGuard.valid_now

    def spy(self) -> bool:
        ok = real(self)
        results.append(ok)
        rechecked.set()
        return ok

    monkeypatch.setattr(StreamAuthGuard, "valid_now", spy)
    with _client(app, cookies=_session_cookie(init_db, member_user)) as c:
        lines: list[str] = []
        done = threading.Event()
        reader = threading.Thread(
            target=_read_stream,
            args=(c, "/api/downloads/events", lines, done),
            daemon=True,
        )
        reader.start()
        try:
            assert rechecked.wait(15), "the stream never rechecked its caller"
            assert not done.is_set()
        finally:
            _stop_streams(app)
            reader.join(10)
        assert done.is_set()
        # The recheck passed, so the tick that ran it was a keepalive, not an exit.
        assert results[0] is True
        assert lines.count(": keepalive") >= 1


def test_chat_stream_stops_when_the_caller_is_revoked(session, add_video, monkeypatch):
    """The reply is neither streamed on nor stored once access is gone."""
    from app.models import VideoAiChatMessage
    from app.services.ai import chat

    user = accounts.create_user(session, "chatter", "chatter-password")
    video = add_video(title="A video", description="About things")

    class Provider:
        last_cost = None

        def chat_stream(self, *_a, **_k):
            yield "hello "
            yield "world"

    monkeypatch.setattr(chat, "get_llm_provider", lambda: Provider())
    monkeypatch.setattr(chat, "ensure_quality_chat_model", lambda: "m")
    monkeypatch.setattr(chat, "require_llm_chat_model", lambda *_: None)
    monkeypatch.setattr(chat, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(chat.ai_embeddings, "build_chat_context", lambda *_: "")

    allowed = iter([True, False])
    events = list(
        chat.stream_chat_events(
            video.id, "hi", user.id, lambda force=False: next(allowed, False)
        )
    )

    assert '"type": "token"' in events[1]
    assert '"status": 401' in events[-1]
    assert not any('"type": "done"' in e for e in events)
    session.expire_all()
    stored = session.exec(select_assistant(VideoAiChatMessage)).all()
    assert stored == []


def select_assistant(model):
    from sqlmodel import select

    return select(model).where(model.role == "assistant")
