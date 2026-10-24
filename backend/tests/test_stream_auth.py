"""Open event streams end when their caller loses access (disable, delete, reset)."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

import pytest
from sqlmodel import Session

from app.auth import STREAM_KEEPALIVE
from app.models import DownloadJob, JobStatus
from app.services.auth import accounts, sessions
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
@pytest.mark.parametrize(
    "change", ["disable", "password", "delete", "logout", "revoked"]
)
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

    elif change == "revoked":
        # "Sign out" on the Signed-in devices list, from another browser or an admin.
        def revoke() -> None:
            with Session(init_db["engine"]) as s:
                (mine,) = sessions.list_sessions(
                    s,
                    member_user.id,
                    current_token=member_client.cookies[accounts.SESSION_COOKIE],
                )
                sessions.revoke(s, member_user.id, mine.id)

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


# --- Proxy identities ---------------------------------------------------------------


def _proxied_app(config):
    from fastapi import FastAPI

    from app.api import downloads
    from app.security import install_security

    proxied = FastAPI()
    proxied.include_router(downloads.router)
    install_security(proxied, auth_config=config)
    proxied.state.auth.stream_recheck_seconds = _RECHECK
    return proxied


def _stream_ends_after(proxied, headers: dict[str, str], revoke) -> None:
    from fastapi.testclient import TestClient

    with TestClient(proxied, headers=headers) as c:
        lines: list[str] = []
        done = threading.Event()
        reader = threading.Thread(
            target=_read_stream,
            args=(c, "/api/downloads/events", lines, done),
            daemon=True,
        )
        reader.start()
        try:
            time.sleep(0.4)
            assert not done.is_set(), "the stream ended before the identity changed"
            revoke()
            assert done.wait(5), "the stream outlived the identity it started with"
        finally:
            _stop_streams(proxied)
            reader.join(5)


def test_a_trusted_header_stream_ends_when_that_account_is_disabled(
    init_db, admin_user
):
    from app.services.auth.runtime import AuthConfig

    with Session(init_db["engine"]) as s:
        kid = accounts.create_user(s, "kid", "kid-password-1")
    proxied = _proxied_app(
        AuthConfig(disabled=True, trust_proxy=True, trusted_user_header="x-user")
    )

    def revoke() -> None:
        with Session(init_db["engine"]) as s:
            accounts.update_user(s, kid.id, disabled=True)

    _stream_ends_after(proxied, {"X-User": "kid"}, revoke)


def test_a_sign_in_disabled_stream_ends_when_the_acting_admin_changes(
    init_db, admin_user
):
    """With sign-in off every request acts as the first enabled administrator."""
    from app.services.auth.runtime import AuthConfig

    with Session(init_db["engine"]) as s:
        accounts.create_user(s, "second", "second-password", is_admin=True)
    proxied = _proxied_app(AuthConfig(disabled=True))

    def revoke() -> None:
        with Session(init_db["engine"]) as s:
            accounts.update_user(s, admin_user.id, disabled=True)

    _stream_ends_after(proxied, {}, revoke)
