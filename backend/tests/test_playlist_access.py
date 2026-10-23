"""Playlists belong to a user: App-wide (public) or Private.

A private playlist does not exist for anyone else (404 everywhere, admins
included); a public one is edited by its owner and by holders of
``manage_playlists``.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import config
from app.models import Playlist, PlaylistItem, PlaylistVisibility
from app.services.auth import accounts

CSRF = {"X-Horde-Request": "1"}


def _make_client(app, init_db, name: str, granted: list[str]) -> TestClient:
    with Session(init_db["engine"]) as s:
        user = accounts.create_user(s, name, "member-password", granted=granted)
        token = accounts.start_session(s, user)
    return TestClient(app, headers=CSRF, cookies={accounts.SESSION_COOKIE: token})


@pytest.fixture
def plain_client(app, init_db, admin_user):
    """A member who may download but holds no manage_playlists grant."""
    with _make_client(app, init_db, "plain", ["download"]) as c:
        yield c


def _create(c, name="Mix", **extra):
    resp = c.post("/api/playlists", json={"name": name, **extra})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _names(c) -> list[str]:
    return [p["name"] for p in c.get("/api/playlists").json()]


def test_a_private_playlist_is_invisible_to_everyone_else(
    client, member_client, add_video
):
    video = add_video(title="Clip")
    secret = _create(member_client, "Secret", visibility="private")
    pid = secret["id"]
    assert secret["visibility"] == "private"
    assert secret["can_edit"] is True
    assert (
        member_client.post(
            f"/api/playlists/{pid}/items", json={"video_id": video.id}
        ).status_code
        == 200
    )

    # The owner sees it; the administrator does not.
    assert _names(member_client) == ["Secret"]
    assert _names(client) == []

    seen = [
        ("GET", f"/api/playlists/{pid}", None),
        ("GET", f"/api/playlists/{pid}/thumbnail", None),
        ("PATCH", f"/api/playlists/{pid}", {"name": "mine now"}),
        ("DELETE", f"/api/playlists/{pid}", None),
        ("POST", f"/api/playlists/{pid}/items", {"video_id": video.id}),
        ("POST", f"/api/playlists/{pid}/items/bulk", {"video_ids": [video.id]}),
        ("DELETE", f"/api/playlists/{pid}/items/{video.id}", None),
        ("PATCH", f"/api/playlists/{pid}/reorder", {"video_ids": [video.id]}),
        ("POST", f"/api/playlists/{pid}/sync", None),
    ]
    for method, path, body in seen:
        resp = client.request(method, path, json=body)
        assert resp.status_code == 404, f"{method} {path}: {resp.status_code}"
        assert resp.json()["detail"] == "Playlist not found"
    upload = client.post(
        f"/api/playlists/{pid}/thumbnail", files={"file": ("a.jpg", b"x", "image/jpeg")}
    )
    assert upload.status_code == 404

    # Nothing changed.
    detail = member_client.get(f"/api/playlists/{pid}").json()
    assert (detail["name"], [v["id"] for v in detail["videos"]]) == (
        "Secret",
        [video.id],
    )


def test_a_download_cannot_target_somebody_elses_private_playlist(
    client, member_client, monkeypatch
):
    from app.services import ytdlp_extract

    monkeypatch.setattr(
        ytdlp_extract,
        "extract_preview",
        lambda url: {"id": "bbbbbbbbbb1", "title": "T", "is_playlist": False},
    )
    pid = _create(member_client, "Secret", visibility="private")["id"]
    body = {"url": "https://www.youtube.com/watch?v=bbbbbbbbbb1", "playlist_id": pid}

    refused = client.post("/api/downloads", json=body)
    assert (refused.status_code, refused.json()["detail"]) == (
        404,
        "Playlist not found",
    )
    assert client.get("/api/downloads").json() == []

    queued = member_client.post("/api/downloads", json=body)
    assert queued.status_code == 200
    assert queued.json()["playlist_id"] == pid


def test_a_download_needs_edit_rights_on_a_public_playlist(
    client, plain_client, monkeypatch
):
    from app.services import ytdlp_extract

    monkeypatch.setattr(
        ytdlp_extract,
        "extract_preview",
        lambda url: {"id": "bbbbbbbbbb1", "title": "T", "is_playlist": False},
    )
    pid = _create(client, "Shared", visibility="public")["id"]
    body = {"url": "https://www.youtube.com/watch?v=bbbbbbbbbb1", "playlist_id": pid}
    denied = plain_client.post("/api/downloads", json=body)
    assert (denied.status_code, denied.json()["code"]) == (403, "permission_denied")
    assert client.post("/api/downloads", json=body).status_code == 200


def test_adding_a_url_to_a_playlist_you_cannot_edit_is_refused(client, plain_client):
    pid = _create(client, "Shared", visibility="public")["id"]
    resp = plain_client.post(
        f"/api/playlists/{pid}/items",
        json={"url": "https://www.youtube.com/watch?v=bbbbbbbbbb1"},
    )
    assert (resp.status_code, resp.json()["code"]) == (403, "permission_denied")
    assert client.get("/api/downloads").json() == []


def test_public_playlists_are_seen_by_all_and_edited_with_the_grant(
    client, member_client, plain_client, add_video
):
    video = add_video(title="Clip")
    shared = _create(client, "Shared", visibility="public")
    pid = shared["id"]
    assert shared["owner"]["username"] == "admin"

    for c in (member_client, plain_client):
        assert _names(c) == ["Shared"]
        assert c.get(f"/api/playlists/{pid}").status_code == 200
        assert c.get(f"/api/playlists/{pid}").json()["owner"]["username"] == "admin"
    can_edit = {
        "member": member_client.get(f"/api/playlists/{pid}").json()["can_edit"],
        "plain": plain_client.get(f"/api/playlists/{pid}").json()["can_edit"],
        "admin": client.get(f"/api/playlists/{pid}").json()["can_edit"],
    }
    assert can_edit == {"member": True, "plain": False, "admin": True}

    # Without manage_playlists every change is a 403 (not a 404: it is visible).
    attempts = [
        ("PATCH", f"/api/playlists/{pid}", {"name": "x"}),
        ("DELETE", f"/api/playlists/{pid}", None),
        ("POST", f"/api/playlists/{pid}/items", {"video_id": video.id}),
        ("POST", f"/api/playlists/{pid}/items/bulk", {"video_ids": [video.id]}),
        ("DELETE", f"/api/playlists/{pid}/items/{video.id}", None),
        ("PATCH", f"/api/playlists/{pid}/reorder", {"video_ids": []}),
    ]
    for method, path, body in attempts:
        resp = plain_client.request(method, path, json=body)
        assert (resp.status_code, resp.json()["code"]) == (
            403,
            "permission_denied",
        ), f"{method} {path}"
    assert plain_client.get(f"/api/playlists/{pid}").json()["name"] == "Shared"

    # With it, the member edits somebody else's public playlist.
    added = member_client.post(
        f"/api/playlists/{pid}/items", json={"video_id": video.id}
    )
    assert added.status_code == 200
    renamed = member_client.patch(f"/api/playlists/{pid}", json={"name": "Renamed"})
    assert renamed.json()["name"] == "Renamed"
    assert member_client.delete(f"/api/playlists/{pid}").status_code == 204


def test_a_member_without_the_grant_makes_private_playlists_only(plain_client):
    # Unspecified: private for those who cannot publish.
    default = _create(plain_client, "Default")
    assert (default["visibility"], default["can_edit"]) == ("private", True)

    refused = plain_client.post(
        "/api/playlists", json={"name": "Loud", "visibility": "public"}
    )
    assert (refused.status_code, refused.json()["code"]) == (403, "permission_denied")
    assert _names(plain_client) == ["Default"]

    # The owner has the full run of it, grant or not.
    pid = default["id"]
    assert (
        plain_client.patch(f"/api/playlists/{pid}", json={"name": "B"}).status_code
        == 200
    )
    assert plain_client.delete(f"/api/playlists/{pid}").status_code == 204


def test_unspecified_visibility_is_public_for_those_who_may_publish(
    client, member_client
):
    assert _create(client, "A")["visibility"] == "public"
    assert _create(member_client, "B")["visibility"] == "public"


def test_only_the_owner_changes_visibility_and_publishing_needs_the_grant(
    client, member_client, plain_client
):
    mine = _create(plain_client, "Mine")["id"]
    # Going public takes manage_playlists.
    refused = plain_client.patch(
        f"/api/playlists/{mine}", json={"visibility": "public"}
    )
    assert (refused.status_code, refused.json()["code"]) == (403, "permission_denied")

    shared = _create(member_client, "Shared", visibility="public")["id"]
    # An editor of a public playlist is not its owner.
    hijack = client.patch(f"/api/playlists/{shared}", json={"visibility": "private"})
    assert (hijack.status_code, hijack.json()["code"]) == (403, "permission_denied")
    assert _names(plain_client) == ["Shared", "Mine"]

    # The owner may take it private, then public again.
    assert (
        member_client.patch(
            f"/api/playlists/{shared}", json={"visibility": "private"}
        ).json()["visibility"]
        == "private"
    )
    assert "Shared" not in _names(client)
    assert (
        member_client.patch(
            f"/api/playlists/{shared}", json={"visibility": "public"}
        ).json()["visibility"]
        == "public"
    )
    assert "Shared" in _names(client)


def test_reorder_moves_only_the_playlists_you_can_edit(
    client, member_client, plain_client
):
    first = _create(client, "Admin one", visibility="public")["id"]
    mine_a = _create(plain_client, "Mine A")["id"]
    second = _create(client, "Admin two", visibility="public")["id"]
    mine_b = _create(plain_client, "Mine B")["id"]
    # Newest first: Mine B, Admin two, Mine A, Admin one.
    assert _names(plain_client) == ["Mine B", "Admin two", "Mine A", "Admin one"]

    ordered = plain_client.patch(
        "/api/playlists/reorder",
        json={"playlist_ids": [first, mine_a, second, mine_b]},
    )
    assert ordered.status_code == 200
    # Her two playlists swapped their slots; the shared ones did not move.
    assert [p["name"] for p in ordered.json()] == [
        "Mine A",
        "Admin two",
        "Mine B",
        "Admin one",
    ]
    # The administrator's view of the shared ones is unchanged.
    assert _names(client) == ["Admin two", "Admin one"]


def test_a_public_playlist_survives_its_owner_a_private_one_does_not(
    client, member_client, member_user, admin_user, init_db, add_video
):
    video = add_video(title="Clip")
    public_id = _create(member_client, "Public", visibility="public")["id"]
    private_id = _create(member_client, "Private", visibility="private")["id"]
    for pid in (public_id, private_id):
        member_client.post(f"/api/playlists/{pid}/items", json={"video_id": video.id})
    cover = member_client.post(
        f"/api/playlists/{private_id}/thumbnail",
        files={"file": ("c.png", _png(), "image/png")},
    )
    assert cover.status_code == 200
    cover_file = init_db["data"] / "thumbnails" / f"playlist_{private_id}.jpg"
    assert cover_file.is_file()

    assert client.delete(f"/api/users/{member_user.id}").status_code == 204

    with Session(init_db["engine"]) as s:
        survivor = s.get(Playlist, public_id)
        assert survivor is not None
        assert survivor.owner_user_id == admin_user.id
        assert survivor.visibility == PlaylistVisibility.public
        assert s.get(Playlist, private_id) is None
        assert [i.playlist_id for i in s.exec(select(PlaylistItem))] == [public_id]
    assert not cover_file.exists()
    shown = client.get("/api/playlists").json()
    assert [(p["name"], p["owner"]["username"], p["can_edit"]) for p in shown] == [
        ("Public", "admin", True)
    ]


def _png() -> bytes:
    from io import BytesIO

    from PIL import Image

    out = BytesIO()
    Image.new("RGB", (8, 8), (20, 80, 80)).save(out, format="PNG")
    return out.getvalue()


def test_deleting_a_user_without_a_named_heir_hands_lists_to_an_admin(
    init_db, admin_user, member_user
):
    with Session(init_db["engine"]) as s:
        s.add(
            Playlist(
                name="Shared",
                owner_user_id=member_user.id,
                visibility=PlaylistVisibility.public,
            )
        )
        s.commit()
        accounts.delete_user(s, member_user.id)
        (kept,) = s.exec(select(Playlist)).all()
        assert kept.owner_user_id == admin_user.id


def test_a_refused_account_deletion_keeps_its_playlists(init_db, admin_user):
    with Session(init_db["engine"]) as s:
        s.add(
            Playlist(
                name="Private",
                owner_user_id=admin_user.id,
                visibility=PlaylistVisibility.private,
            )
        )
        s.commit()
        with pytest.raises(accounts.LastAdmin):
            accounts.delete_user(s, admin_user.id)
        assert [p.name for p in s.exec(select(Playlist))] == ["Private"]


def test_the_first_administrator_adopts_playlists_that_predate_accounts(init_db):
    with Session(init_db["engine"]) as s:
        s.add(Playlist(name="Old"))
        s.commit()
        first = accounts.create_user(s, "first", "first-password", is_admin=True)
        (old,) = s.exec(select(Playlist)).all()
        assert (old.owner_user_id, old.visibility) == (
            first.id,
            PlaylistVisibility.public,
        )


def test_importing_a_playlist_honours_visibility_and_hides_private_subscriptions(
    client, plain_client, monkeypatch
):
    from app.services import ytdlp_extract
    from app.services.downloads import playlist_import

    monkeypatch.setattr(
        ytdlp_extract,
        "extract_playlist",
        lambda url: ("Build Log", ["https://www.youtube.com/watch?v=aaaaaaaaaa1"]),
    )
    monkeypatch.setattr(playlist_import, "start_playlist_import", lambda *a, **k: None)
    url = "https://www.youtube.com/playlist?list=PL123"

    imported = plain_client.post(
        "/api/playlists/import", json={"url": url, "subscribe": True}
    )
    assert imported.status_code == 200
    assert imported.json()["visibility"] == "private"

    # Her private subscription does not block the administrator, nor reveal itself.
    again = client.post("/api/playlists/import", json={"url": url, "subscribe": True})
    assert again.status_code == 200
    assert again.json()["visibility"] == "public"
    dup = plain_client.post(
        "/api/playlists/import", json={"url": url, "subscribe": True}
    )
    assert dup.status_code == 409

    refused = plain_client.post(
        "/api/playlists/import", json={"url": url, "visibility": "public"}
    )
    assert (refused.status_code, refused.json()["code"]) == (403, "permission_denied")


def test_restoring_a_video_puts_it_back_in_a_private_playlist(
    client, member_client, member_user, add_video, init_db, monkeypatch
):
    monkeypatch.setattr(config, "TRASH_DAYS", 7)
    video = add_video(write_file=True, title="Clip")
    other = add_video(write_file=True, title="Other")
    private_id = _create(member_client, "Private", visibility="private")["id"]
    gone_id = _create(member_client, "Gone", visibility="private")["id"]
    for pid in (private_id, gone_id):
        member_client.post(f"/api/playlists/{pid}/items", json={"video_id": video.id})
    member_client.post(
        f"/api/playlists/{private_id}/items", json={"video_id": other.id}
    )

    trashed = client.delete(f"/api/videos/{video.id}?delete_file=true")
    assert trashed.status_code == 204
    entry_id = int(trashed.headers["x-horde-trash-entry"])
    assert member_client.delete(f"/api/playlists/{gone_id}").status_code == 204

    # The administrator restores it: the membership of a playlist they cannot see
    # comes back, and the one whose playlist is gone is skipped.
    assert client.post(f"/api/trash/{entry_id}/restore").status_code == 200
    with Session(init_db["engine"]) as s:
        memberships = {
            (i.playlist_id, i.video_id) for i in s.exec(select(PlaylistItem)).all()
        }
    assert memberships == {(private_id, video.id), (private_id, other.id)}
    assert client.get(f"/api/playlists/{private_id}").status_code == 404
    detail = member_client.get(f"/api/playlists/{private_id}").json()
    assert {v["id"] for v in detail["videos"]} == {video.id, other.id}
