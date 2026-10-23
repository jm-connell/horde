"""Sharing downloads between accounts: the setting, and who sees device jobs."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.models import DownloadDestination, DownloadJob, JobStatus, User
from app.services import follows
from app.services.auth import accounts
from tests.conftest import CSRF, MEMBER_PASSWORD, _session_cookie

OTHER_PASSWORD = "other-password"


@pytest.fixture
def other_user(init_db, admin_user):
    with Session(init_db["engine"]) as s:
        return accounts.create_user(s, "other", OTHER_PASSWORD)


@pytest.fixture
def other_client(app, init_db, other_user):
    with TestClient(
        app, headers=CSRF, cookies=_session_cookie(init_db, other_user)
    ) as c:
        yield c


def _share(init_db, user, share: bool) -> None:
    with Session(init_db["engine"]) as s:
        accounts.set_share_downloads(s, user.id, share)


# --- the setting -------------------------------------------------------------


def test_sharing_is_on_by_default(client, member_user):
    assert client.get("/api/auth/state").json()["user"]["share_downloads"] is True
    listed = {u["username"]: u for u in client.get("/api/users").json()}
    assert listed["member"]["share_downloads"] is True


def test_bootstrap_can_turn_sharing_off(app, init_db):
    with TestClient(app, headers=CSRF) as c:
        resp = c.post(
            "/api/auth/bootstrap",
            json={
                "username": "Owner",
                "password": "first-password",
                "share_downloads": False,
            },
        )
        assert resp.status_code == 200
        assert resp.json()["user"]["share_downloads"] is False
        assert c.get("/api/auth/state").json()["user"]["share_downloads"] is False


def test_admin_sets_it_when_creating_and_editing_a_user(client):
    created = client.post(
        "/api/users",
        json={"username": "kid", "password": "kid-password", "share_downloads": False},
    )
    assert created.status_code == 201
    assert created.json()["share_downloads"] is False
    uid = created.json()["id"]

    edited = client.patch(f"/api/users/{uid}", json={"share_downloads": True})
    assert edited.json()["share_downloads"] is True
    # Omitted means unchanged.
    untouched = client.patch(f"/api/users/{uid}", json={"disabled": False})
    assert untouched.json()["share_downloads"] is True


def test_stopping_sharing_needs_your_password(member_client):
    missing = member_client.patch("/api/auth/me", json={"share_downloads": False})
    assert (missing.status_code, missing.json()["code"]) == (400, "password_required")

    wrong = member_client.patch(
        "/api/auth/me", json={"share_downloads": False, "current_password": "nope"}
    )
    assert (wrong.status_code, wrong.json()["code"]) == (400, "wrong_password")
    assert member_client.get("/api/auth/state").json()["user"]["share_downloads"]

    ok = member_client.patch(
        "/api/auth/me",
        json={"share_downloads": False, "current_password": MEMBER_PASSWORD},
    )
    assert ok.status_code == 200
    assert ok.json()["share_downloads"] is False
    assert (
        member_client.get("/api/auth/state").json()["user"]["share_downloads"] is False
    )


def test_turning_sharing_back_on_needs_no_password(member_client):
    member_client.patch(
        "/api/auth/me",
        json={"share_downloads": False, "current_password": MEMBER_PASSWORD},
    )
    back = member_client.patch("/api/auth/me", json={"share_downloads": True})
    assert (back.status_code, back.json()["share_downloads"]) == (200, True)


def test_password_guesses_for_it_are_throttled(member_client):
    from app.services.auth.limiter import FREE_ATTEMPTS

    for _ in range(FREE_ATTEMPTS):
        member_client.patch(
            "/api/auth/me", json={"share_downloads": False, "current_password": "x"}
        )
    blocked = member_client.patch(
        "/api/auth/me",
        json={"share_downloads": False, "current_password": MEMBER_PASSWORD},
    )
    assert (blocked.status_code, blocked.json()["code"]) == (429, "rate_limited")


def test_anonymous_cannot_change_it(anon_client):
    resp = anon_client.patch("/api/auth/me", json={"share_downloads": True})
    assert resp.status_code == 401


# --- device jobs -------------------------------------------------------------


def _device_job(init_db, requester=None, *, title="Clip") -> int:
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            quality_preset="720p",
            status=JobStatus.completed,
            destination=DownloadDestination.device.value,
            title=title,
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        assert job.id is not None
        rel = f"_device/{job.id}/{title}.mp4"
        path = init_db["downloads"] / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\x00" * 16)
        job.device_file_path = rel
        s.add(job)
        if requester is not None:
            follows.record_requester(s, job.id, requester.id)
        s.commit()
        return job.id


def _library_job(init_db, requester) -> int:
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url="https://www.youtube.com/watch?v=aaaaaaaaaaa",
            quality_preset="best",
            status=JobStatus.completed,
            destination=DownloadDestination.library.value,
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        assert job.id is not None
        follows.record_requester(s, job.id, requester.id)
        s.commit()
        return job.id


def _listed_ids(c: TestClient) -> set[int]:
    return {j["id"] for j in c.get("/api/downloads").json()}


def test_a_shared_device_job_is_open_to_other_members(
    init_db, member_user, other_client
):
    job_id = _device_job(init_db, member_user)
    assert other_client.get(f"/api/downloads/{job_id}/file").status_code == 200
    assert job_id in _listed_ids(other_client)
    assert other_client.get(f"/api/downloads/{job_id}").status_code == 200


def test_a_private_device_job_is_a_404_for_other_members(
    init_db, member_user, other_client, member_client
):
    job_id = _device_job(init_db, member_user)
    _share(init_db, member_user, False)

    assert other_client.get(f"/api/downloads/{job_id}/file").status_code == 404
    assert other_client.get(f"/api/downloads/{job_id}").status_code == 404
    assert job_id not in _listed_ids(other_client)
    assert other_client.delete(f"/api/downloads/{job_id}").status_code == 404
    # The owner still has it.
    assert member_client.get(f"/api/downloads/{job_id}/file").status_code == 200
    assert job_id in _listed_ids(member_client)


def test_administrators_see_private_device_jobs(init_db, member_user, client):
    job_id = _device_job(init_db, member_user)
    _share(init_db, member_user, False)
    assert client.get(f"/api/downloads/{job_id}/file").status_code == 200
    assert job_id in _listed_ids(client)


def test_jobs_nobody_requested_stay_visible(init_db, member_user, other_client):
    job_id = _device_job(init_db, None)
    _share(init_db, member_user, False)
    assert other_client.get(f"/api/downloads/{job_id}/file").status_code == 200


def test_library_jobs_are_not_affected(init_db, member_user, other_client):
    job_id = _library_job(init_db, member_user)
    _share(init_db, member_user, False)
    assert job_id in _listed_ids(other_client)


def test_dismiss_finished_leaves_another_accounts_private_jobs(
    init_db, member_user, other_client, member_client
):
    private = _device_job(init_db, member_user, title="Private")
    _share(init_db, member_user, False)
    mine = _device_job(init_db, None, title="Mine")

    assert other_client.post("/api/downloads/dismiss-finished").status_code == 204
    assert private in _listed_ids(member_client)
    assert mine not in _listed_ids(member_client)
    assert (init_db["downloads"] / f"_device/{private}/Private.mp4").exists()


def test_a_private_job_has_no_progress_stream_for_others(
    init_db, member_user, other_client
):
    job_id = _device_job(init_db, member_user)
    _share(init_db, member_user, False)
    assert other_client.get(f"/api/downloads/{job_id}/events").status_code == 404


def test_user_row_default_is_sharing(init_db, admin_user):
    with Session(init_db["engine"]) as s:
        assert s.get(User, admin_user.id).share_downloads is True  # type: ignore[union-attr]  # row exists


# --- a private job is invisible through every route that takes a job id -----

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def _private_queued_job(init_db, owner, *, status=JobStatus.queued) -> int:
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url=URL,
            quality_preset="720p",
            status=status,
            destination=DownloadDestination.device.value,
            title="Secret title",
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        assert job.id is not None
        follows.record_requester(s, job.id, owner.id)
        accounts.set_share_downloads(s, owner.id, False)
        s.commit()
        return job.id


@pytest.mark.parametrize(
    ("method", "suffix", "body"),
    [
        ("patch", "", {}),
        ("patch", "", {"title_override": "mine now"}),
        ("post", "/retry", None),
        ("post", "/quality", {"quality_preset": "1080p"}),
        ("post", "/cancel", None),
        ("delete", "", None),
        ("get", "", None),
        ("get", "/file", None),
        ("get", "/events", None),
    ],
)
def test_every_job_route_treats_a_private_job_as_missing(
    init_db, member_user, other_client, method, suffix, body
):
    job_id = _private_queued_job(init_db, member_user)
    kwargs = {} if body is None else {"json": body}
    resp = getattr(other_client, method)(f"/api/downloads/{job_id}{suffix}", **kwargs)
    assert resp.status_code == 404
    assert "Secret title" not in resp.text
    # Nothing happened to it.
    with Session(init_db["engine"]) as s:
        job = s.get(DownloadJob, job_id)
        assert job is not None
        assert (job.status, job.title_override, job.quality_preset) == (
            JobStatus.queued,
            None,
            "720p",
        )


def test_the_owner_and_an_admin_still_reach_a_private_job(
    init_db, member_user, member_client, client
):
    job_id = _private_queued_job(init_db, member_user)
    assert member_client.patch(f"/api/downloads/{job_id}", json={}).status_code == 200
    assert client.patch(f"/api/downloads/{job_id}", json={}).status_code == 200
    assert member_client.post(f"/api/downloads/{job_id}/cancel").status_code == 200


def test_a_hidden_job_does_not_make_a_link_look_queued(
    init_db, member_user, other_client, other_user
):
    hidden = _private_queued_job(init_db, member_user)
    resp = other_client.post("/api/downloads", json={"url": URL})
    assert resp.status_code == 200
    assert resp.json()["id"] != hidden
    # Two accounts' private requests for one link do not collide.
    with Session(init_db["engine"]) as s:
        assert len(s.exec(select(DownloadJob)).all()) == 2


def test_a_playlist_is_not_written_onto_a_hidden_job(
    init_db, member_user, other_client
):
    hidden = _private_queued_job(init_db, member_user)
    playlist = other_client.post(
        "/api/playlists", json={"name": "mine", "visibility": "private"}
    ).json()
    resp = other_client.post(
        "/api/downloads", json={"url": URL, "playlist_id": playlist["id"]}
    )
    assert resp.status_code == 200
    assert resp.json()["id"] != hidden
    assert "Secret title" not in resp.text
    with Session(init_db["engine"]) as s:
        job = s.get(DownloadJob, hidden)
        assert job is not None
        assert job.playlist_id is None


def test_a_visible_duplicate_is_still_refused(init_db, member_user, other_client):
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url=URL,
            quality_preset="720p",
            status=JobStatus.queued,
            destination=DownloadDestination.device.value,
        )
        s.add(job)
        s.commit()
    resp = other_client.post("/api/downloads", json={"url": URL})
    assert (resp.status_code, resp.json()["code"]) == (409, "already_queued")


def test_a_playlist_is_attached_to_a_visible_duplicate(other_client, init_db):
    playlist = other_client.post(
        "/api/playlists", json={"name": "mine", "visibility": "private"}
    ).json()
    with Session(init_db["engine"]) as s:
        s.add(
            DownloadJob(
                url=URL,
                quality_preset="best",
                status=JobStatus.queued,
                destination="library",
            )
        )
        s.commit()
    resp = other_client.post(
        "/api/downloads", json={"url": URL, "playlist_id": playlist["id"]}
    )
    assert resp.status_code == 200
    assert resp.json()["playlist_id"] == playlist["id"]


# --- the playlist a library job feeds ----------------------------------------


def test_jobs_do_not_name_somebody_elses_private_playlist(
    init_db, member_client, other_client, client
):
    playlist = member_client.post(
        "/api/playlists", json={"name": "secret", "visibility": "private"}
    ).json()
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url=URL,
            quality_preset="best",
            status=JobStatus.queued,
            destination="library",
            playlist_id=playlist["id"],
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        job_id = job.id

    def playlist_ids(c: TestClient) -> list[int | None]:
        return [j["playlist_id"] for j in c.get("/api/downloads").json()]

    assert playlist_ids(member_client) == [playlist["id"]]
    assert playlist_ids(other_client) == [None]
    assert playlist_ids(client) == [None]  # administrators get no view either
    assert other_client.get(f"/api/downloads/{job_id}").json()["playlist_id"] is None
    assert (
        member_client.get(f"/api/downloads/{job_id}").json()["playlist_id"]
        == playlist["id"]
    )


def test_jobs_keep_the_public_playlist_they_feed(client, other_client, init_db):
    playlist = client.post(
        "/api/playlists", json={"name": "open", "visibility": "public"}
    ).json()
    with Session(init_db["engine"]) as s:
        s.add(
            DownloadJob(
                url=URL,
                quality_preset="best",
                status=JobStatus.queued,
                destination="library",
                playlist_id=playlist["id"],
            )
        )
        s.commit()
    assert [j["playlist_id"] for j in other_client.get("/api/downloads").json()] == [
        playlist["id"]
    ]


# --- the queue-wide progress stream ------------------------------------------


def test_the_hidden_filter_for_the_progress_stream(init_db, member_user, other_user):
    from app.api.downloads import _hidden_from_stream

    private = _private_queued_job(init_db, member_user)
    shared = _device_job(init_db, other_user)
    library = _library_job(init_db, member_user)
    ids = {private, shared, library, 9999}

    with Session(init_db["engine"]) as s:
        other = accounts.AuthUser.of(s.get(User, other_user.id))  # type: ignore[arg-type]  # row exists
        owner = accounts.AuthUser.of(s.get(User, member_user.id))  # type: ignore[arg-type]  # row exists
    assert _hidden_from_stream(other, ids) == {private}
    assert _hidden_from_stream(owner, ids) == set()


def test_the_queue_stream_skips_a_hidden_jobs_progress(
    app, init_db, member_user, other_client
):
    import threading
    import time

    from app.services.downloads.progress import progress_store

    hidden = _private_queued_job(init_db, member_user)
    visible = _device_job(init_db, None, title="Open")
    progress_store[hidden] = {"status": "downloading", "title": "Secret title"}
    progress_store[visible] = {"status": "downloading", "title": "Open"}
    lines: list[str] = []

    def read() -> None:
        with other_client.stream("GET", "/api/downloads/events") as resp:
            lines.extend(resp.iter_lines())

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        time.sleep(1.2)
    finally:
        app.state.shutdown_event = (
            getattr(app.state, "shutdown_event", None) or threading.Event()
        )
        app.state.shutdown_event.set()
        reader.join(5)
        progress_store.pop(hidden, None)
        progress_store.pop(visible, None)
    data = "\n".join(line for line in lines if line.startswith("data:"))
    assert f'"job_id": {visible}' in data
    assert "Secret title" not in data
