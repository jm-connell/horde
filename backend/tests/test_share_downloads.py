"""Sharing downloads between accounts: the setting, and who sees device jobs."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

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
