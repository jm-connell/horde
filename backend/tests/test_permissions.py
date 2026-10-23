"""Who may do what: administrators, members and the grantable permissions.

``GATES`` is the contract. Every route that needs more than a signed-in user
appears in it (the introspection test fails when a route gains or loses a gate,
or when a mutating route is neither listed nor in ``OPEN_MUTATIONS``), so a new
route has to be classified on purpose.
"""

from __future__ import annotations

import re

import pytest
from fastapi.routing import APIRoute, iter_route_contexts
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.services.auth import accounts, permissions

ADMIN = "admin"

# (method, path) -> "admin" or a permission name
GATES: dict[tuple[str, str], str] = {
    # --- administrators only ---
    **{
        (m, p): ADMIN
        for m, p in [
            ("GET", "/api/users"),
            ("GET", "/api/users/permissions"),
            ("POST", "/api/users"),
            ("PATCH", "/api/users/{user_id}"),
            ("DELETE", "/api/users/{user_id}"),
            ("GET", "/api/users/{user_id}/sessions"),
            ("DELETE", "/api/users/{user_id}/sessions"),
            ("DELETE", "/api/users/{user_id}/sessions/{session_id}"),
            ("POST", "/api/setup/reset"),
            ("POST", "/api/ai/apply-workload"),
            ("POST", "/api/ai/test"),
            ("POST", "/api/ai/openrouter/test"),
            ("GET", "/api/ai/openrouter/models"),
            ("GET", "/api/ai/openrouter/costs"),
            ("POST", "/api/ai/process"),
            ("POST", "/api/ai/pause"),
            ("POST", "/api/ai/resume"),
            ("GET", "/api/ai/jobs"),
            ("GET", "/api/system/update"),
            ("POST", "/api/system/update"),
            ("POST", "/api/system/update/cancel"),
            ("POST", "/api/ai/jobs/retry-failed"),
            ("POST", "/api/ai/jobs/clear-failed"),
            ("POST", "/api/ai/jobs/{job_id}/retry"),
            ("POST", "/api/ai/jobs/{job_id}/cancel"),
            # Library-wide codec totals: only the compatibility settings read them.
            ("GET", "/api/compat/summary"),
            ("POST", "/api/compat/backfill"),
            ("POST", "/api/compat/convert-library"),
            ("POST", "/api/compat/cancel"),
            ("POST", "/api/backgrounds"),
            ("DELETE", "/api/backgrounds/{bg_id}"),
            ("POST", "/api/backgrounds/{bg_id}/palette"),
            ("POST", "/api/fonts"),
            ("DELETE", "/api/fonts/{font_id}"),
            ("POST", "/api/downloads/queue/pause"),
            ("POST", "/api/downloads/queue/resume"),
            ("POST", "/api/videos/refresh-metadata"),
            # Its progress names the video being synced and the raw last error.
            ("GET", "/api/videos/refresh-metadata/status"),
            # Queue and worker internals.
            ("GET", "/api/metrics"),
        ]
    },
    # --- delete_videos ---
    ("POST", "/api/videos/bulk-delete"): "delete_videos",
    ("DELETE", "/api/videos/{video_id}"): "delete_videos",
    # Removing the H.264 sidecar deletes a file from the server.
    ("DELETE", "/api/videos/{video_id}/compat"): "delete_videos",
    # The trash holds deleted videos: seeing, restoring and erasing them is the same right.
    **{
        (m, p): "delete_videos"
        for m, p in [
            ("GET", "/api/trash"),
            ("GET", "/api/trash/summary"),
            ("POST", "/api/trash/empty"),
            ("GET", "/api/trash/{entry_id}/thumbnail"),
            ("POST", "/api/trash/{entry_id}/restore"),
            ("DELETE", "/api/trash/{entry_id}"),
        ]
    },
    # --- download ---
    **{
        (m, p): "download"
        for m, p in [
            ("GET", "/api/downloads/preview"),
            ("PATCH", "/api/downloads/{job_id}"),
            ("POST", "/api/downloads/{job_id}/retry"),
            ("POST", "/api/downloads/{job_id}/quality"),
            ("POST", "/api/downloads/{job_id}/cancel"),
            ("POST", "/api/downloads/dismiss-finished"),
            ("DELETE", "/api/downloads/{job_id}"),
            ("POST", "/api/videos/{video_id}/redownload"),
            ("POST", "/api/channels/catalog/index"),
            ("PUT", "/api/channels/autodownload"),
            ("GET", "/api/playlists/preview"),
            # Also manage_playlists for an App-wide playlist, decided in the handler.
            ("POST", "/api/playlists/import"),
            ("POST", "/api/review/scan"),
            ("POST", "/api/review/upload"),
        ]
    },
    # --- offline_download ---
    ("GET", "/api/downloads/{job_id}/file"): "offline_download",
    ("GET", "/api/videos/{video_id}/file"): "offline_download",
    # --- edit_metadata ---
    **{
        (m, p): "edit_metadata"
        for m, p in [
            ("PATCH", "/api/videos/bulk-notes"),
            ("PATCH", "/api/videos/{video_id}"),
            ("POST", "/api/videos/{video_id}/refresh-metadata"),
            ("POST", "/api/videos/{video_id}/thumbnail"),
            ("POST", "/api/videos/{video_id}/thumbnail/candidates"),
            ("POST", "/api/videos/{video_id}/thumbnail/candidates/{index}"),
            ("PATCH", "/api/channels"),
            ("PATCH", "/api/channels/catalog/youtube-search"),
            ("POST", "/api/review/{video_id}/skip"),
        ]
    },
    # --- use_ai ---
    **{
        (m, p): "use_ai"
        for m, p in [
            ("POST", "/api/videos/{video_id}/ai/refresh-tags"),
            ("POST", "/api/videos/{video_id}/ai/summarize"),
            ("POST", "/api/videos/{video_id}/ai/chapters"),
            ("GET", "/api/videos/{video_id}/ai/chat"),
            ("DELETE", "/api/videos/{video_id}/ai/chat"),
            ("POST", "/api/videos/{video_id}/ai/chat"),
            ("GET", "/api/preview/ai"),
            ("POST", "/api/preview/ai/summarize"),
            ("POST", "/api/preview/ai/chapters"),
            ("GET", "/api/preview/ai/chat"),
            ("DELETE", "/api/preview/ai/chat"),
            ("POST", "/api/preview/ai/chat"),
        ]
    },
}

#: Needs two permissions (both are checked).
GATES_ALL_OF: dict[tuple[str, str], set[str]] = {}

#: Gated inside the handler because the answer depends on the request.
CONDITIONAL = {
    ("POST", "/api/downloads"),  # download, or offline_download for destination=device
    ("POST", "/api/downloads/bulk"),
    ("PATCH", "/api/settings"),  # ui: anyone; anything else: admin
    ("GET", "/api/updates"),  # ?refresh=true: admin
    # Playlists belong to a user: the owner may always change theirs, and anyone with
    # manage_playlists may change a public one (services/playlists.py decides, 404 for
    # another user's private playlist, 403 for a public one you may not change).
    # Making a private playlist needs no grant, an App-wide one needs manage_playlists.
    ("POST", "/api/playlists"),
    ("PATCH", "/api/playlists/reorder"),
    ("PATCH", "/api/playlists/{playlist_id}"),
    ("DELETE", "/api/playlists/{playlist_id}"),
    ("POST", "/api/playlists/{playlist_id}/items"),
    ("POST", "/api/playlists/{playlist_id}/items/bulk"),
    ("DELETE", "/api/playlists/{playlist_id}/items/{video_id}"),
    ("PATCH", "/api/playlists/{playlist_id}/reorder"),
    ("POST", "/api/playlists/{playlist_id}/thumbnail"),
    ("POST", "/api/playlists/{playlist_id}/sync"),
}

#: Mutations any signed-in user may make, on purpose. The compat and sprite
#: routes only cost CPU (they build a playback copy or seek previews that
#: watching needs, e.g. Safari), so they stay open; removing a file is gated.
OPEN_MUTATIONS = {
    ("PATCH", "/api/videos/{video_id}/progress"),  # your own history
    ("POST", "/api/videos/{video_id}/compat"),  # playback compatibility copies
    ("POST", "/api/videos/{video_id}/compat/safari"),
    ("POST", "/api/videos/{video_id}/sprites/generate"),  # seek previews
    ("POST", "/api/playlists/estimate"),  # read-only size estimate
    ("POST", "/api/auth/logout"),
    ("POST", "/api/auth/password"),  # your own password
    ("POST", "/api/auth/sessions/revoke-others"),  # your own signed-in devices
    ("DELETE", "/api/auth/sessions/{session_id}"),
    ("POST", "/api/auth/avatar"),  # your own profile picture
    ("DELETE", "/api/auth/avatar"),
    ("PUT", "/api/follows"),  # your own followed channels
    ("DELETE", "/api/follows"),
}
PUBLIC = {
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/bootstrap"),
    ("POST", "/api/auth/forgot"),
    ("POST", "/api/auth/reset"),
}
SAFE = {"GET", "HEAD", "OPTIONS"}


def _gates_of(route) -> set[str]:
    found: set[str] = set()

    def walk(dependant) -> None:
        for sub in dependant.dependencies:
            call = sub.call
            if getattr(call, "admin_only", False):
                found.add(ADMIN)
            perm = getattr(call, "permission", None)
            if perm:
                found.add(perm)
            walk(sub)

    walk(route.dependant)
    return found


def _routes(app):
    # Routers are included lazily, so ask FastAPI for the effective routes.
    for route in iter_route_contexts(app.routes):
        if isinstance(route.original_route, APIRoute) and route.path.startswith("/api"):
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                yield method, route, route.path


def test_gates_match_the_routes_exactly(app):
    expected = {key: {gate} for key, gate in GATES.items()}
    expected.update({key: set(v) for key, v in GATES_ALL_OF.items()})
    actual = {
        (method, path): gates
        for method, route, path in _routes(app)
        if (gates := _gates_of(route))
    }
    assert actual == expected


def test_every_mutating_route_is_classified(app):
    classified = set(GATES) | set(GATES_ALL_OF) | CONDITIONAL | OPEN_MUTATIONS | PUBLIC
    unclassified = sorted(
        f"{method} {path}"
        for method, _route, path in _routes(app)
        if method not in SAFE and (method, path) not in classified
    )
    assert unclassified == [], (
        "New mutating routes must be added to GATES (or OPEN_MUTATIONS on purpose)"
    )


def test_every_permission_is_used_and_documented():
    used = {g for g in GATES.values() if g != ADMIN} | {
        p for ps in GATES_ALL_OF.values() for p in ps
    }
    used |= {"offline_download"}  # also checked for destination=device
    used |= {"manage_playlists"}  # checked per playlist (see CONDITIONAL)
    assert used == set(permissions.ALL_PERMISSIONS)
    assert {
        "download",
        "offline_download",
        "edit_metadata",
        "manage_playlists",
        "use_ai",
    } == permissions.DEFAULT_PERMISSIONS


# --- behaviour ---------------------------------------------------------------


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", path)


@pytest.fixture
def member_with(app, init_db, admin_user):
    """A signed-in member holding exactly the given permissions."""
    clients: list[TestClient] = []
    counter = {"n": 0}

    def make(*granted: str) -> TestClient:
        counter["n"] += 1
        with Session(init_db["engine"]) as s:
            user = accounts.create_user(
                s, f"m{counter['n']}", "member-password", granted=list(granted)
            )
            token = accounts.start_session(s, user)
        c = TestClient(
            app,
            headers={"X-Horde-Request": "1"},
            cookies={accounts.SESSION_COOKIE: token},
        )
        clients.append(c)
        return c

    yield make
    for c in clients:
        c.close()


def _call(c: TestClient, method: str, path: str):
    return c.request(method, _concrete(path))


def test_members_get_403_on_admin_only_routes(member_with):
    member = member_with(*permissions.ALL_PERMISSIONS)  # every grant is still not admin
    for (method, path), gate in GATES.items():
        if gate != ADMIN:
            continue
        resp = _call(member, method, path)
        assert resp.status_code == 403, f"{method} {path}"
        assert resp.json()["code"] == "admin_required"


def test_each_permission_gates_its_routes(member_with, client):
    everything = set(permissions.ALL_PERMISSIONS)
    for perm in sorted(everything):
        without = member_with(*(everything - {perm}))
        only = member_with(perm)
        for (method, path), gate in GATES.items():
            if gate != perm:
                continue
            denied = _call(without, method, path)
            assert denied.status_code == 403, f"{method} {path} without {perm}"
            assert denied.json()["code"] == "permission_denied"
            allowed = _call(only, method, path)
            assert allowed.status_code not in (401, 403), (
                f"{method} {path} with {perm} answered {allowed.status_code}"
            )
        # An administrator needs no grant at all.
        for (method, path), gate in GATES.items():
            if gate == perm:
                assert _call(client, method, path).status_code != 403


def test_playlist_import_needs_download(member_with):
    method, path = "POST", "/api/playlists/import"
    assert _call(member_with("manage_playlists"), method, path).status_code == 403
    assert _call(member_with("download"), method, path).status_code not in (401, 403)


def test_new_members_get_the_default_grants(client):
    created = client.post(
        "/api/users", json={"username": "newbie", "password": "newbie-password"}
    ).json()
    assert set(created["permissions"]) == permissions.DEFAULT_PERMISSIONS
    assert "delete_videos" not in created["permissions"]


def test_default_member_cannot_delete_but_can_edit(member_client, add_video):
    video = add_video(title="Keep me")
    assert member_client.delete(f"/api/videos/{video.id}").status_code == 403
    assert (
        member_client.post(
            "/api/videos/bulk-delete",
            json={"video_ids": [video.id], "delete_files": False},
        ).status_code
        == 403
    )
    assert (
        member_client.patch(f"/api/videos/{video.id}", json={"notes": "n"}).status_code
        == 200
    )


def test_a_granted_delete_really_deletes(member_with, add_video):
    video = add_video(title="Doomed")
    member = member_with("delete_videos")
    assert member.delete(f"/api/videos/{video.id}").status_code == 204
    assert member.get(f"/api/videos/{video.id}").status_code == 404


def test_download_destination_decides_the_permission(member_with):
    body = {"url": "https://example.com/v"}
    library_only = member_with("download")
    device_only = member_with("offline_download")
    nothing = member_with()
    device = {**body, "destination": "device"}

    assert nothing.post("/api/downloads", json=body).status_code == 403
    assert nothing.post("/api/downloads", json=device).status_code == 403
    assert device_only.post("/api/downloads", json=body).status_code == 403
    assert library_only.post("/api/downloads", json=device).status_code == 403
    assert device_only.post("/api/downloads", json=device).status_code not in (401, 403)
    assert library_only.post("/api/downloads", json=body).status_code not in (401, 403)
    bulk = {"urls": ["https://example.com/v"]}
    assert nothing.post("/api/downloads/bulk", json=bulk).status_code == 403
    assert library_only.post("/api/downloads/bulk", json=bulk).status_code not in (
        401,
        403,
    )


def test_forcing_an_update_check_is_admin_only(init_db, member_user):
    from app.main import app as real_app

    with Session(init_db["engine"]) as s:
        token = accounts.start_session(s, member_user)
    with TestClient(real_app, cookies={accounts.SESSION_COOKIE: token}) as member:
        resp = member.get("/api/updates", params={"refresh": True})
    assert (resp.status_code, resp.json()["code"]) == (403, "admin_required")


def test_permission_changes_apply_to_a_live_session(client, member_client, member_user):
    mine = member_client.post("/api/playlists", json={"name": "Mine"})
    assert (mine.status_code, mine.json()["visibility"]) == (200, "public")
    resp = client.patch(
        f"/api/users/{member_user.id}", json={"permissions": ["use_ai"]}
    )
    assert resp.status_code == 200
    denied = member_client.post(
        "/api/playlists", json={"name": "Again", "visibility": "public"}
    )
    assert (denied.status_code, denied.json()["code"]) == (403, "permission_denied")
    # A private playlist needs no grant, and stays editable by its owner.
    private = member_client.post("/api/playlists", json={"name": "Again"})
    assert (private.status_code, private.json()["visibility"]) == (200, "private")


def test_state_reports_effective_permissions(client, member_client):
    admin = client.get("/api/auth/state").json()["user"]
    assert set(admin["permissions"]) == permissions.ALL_PERMISSIONS
    member = member_client.get("/api/auth/state").json()["user"]
    assert set(member["permissions"]) == permissions.DEFAULT_PERMISSIONS


def test_unknown_permission_is_rejected(client):
    resp = client.post(
        "/api/users",
        json={"username": "x1", "password": "password-x1", "permissions": ["fly"]},
    )
    assert (resp.status_code, resp.json()["code"]) == (400, "invalid_permission")
