"""Profile pictures: upload, serve, remove, and cleanup when a user is deleted."""

from __future__ import annotations

import io

from PIL import Image

from app.context import get_paths


def _png(width: int = 400, height: int = 200) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 40, 40)).save(out, "PNG")
    return out.getvalue()


def _upload(c, data: bytes, name: str = "me.png"):
    return c.post("/api/auth/avatar", files={"file": (name, data, "image/png")})


def test_upload_stores_a_square_jpeg_and_bumps_the_version(client):
    me = client.get("/api/auth/state").json()["user"]
    assert me["avatar_version"] is None

    first = _upload(client, _png())
    assert first.status_code == 200
    v1 = first.json()["avatar_version"]
    assert isinstance(v1, int)
    second = _upload(client, _png())
    v2 = second.json()["avatar_version"]
    assert v2 > v1
    assert client.get("/api/auth/state").json()["user"]["avatar_version"] == v2
    # The replaced picture's file is gone; only the current one is kept.
    assert sorted(p.name for p in get_paths().avatars.iterdir()) == [
        f"{me['id']}_{v2}.jpg"
    ]

    served = client.get(f"/api/auth/avatar/{me['id']}")
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/jpeg"
    with Image.open(io.BytesIO(served.content)) as img:
        assert img.format == "JPEG"
        assert img.size == (256, 256)


def test_not_an_image_is_refused(client):
    res = _upload(client, b"<svg onload=alert(1)></svg>", "x.svg")
    assert res.status_code == 400
    assert res.json()["code"] == "bad_image"
    me = client.get("/api/auth/state").json()["user"]
    assert me["avatar_version"] is None


def test_an_image_too_large_to_decode_is_refused(client, monkeypatch):
    from app.services import thumbnails

    # The cap is read from the header, before decoding; a small cap stands in
    # for a huge, highly compressed upload.
    monkeypatch.setattr(thumbnails, "MAX_DECODE_PIXELS", 400 * 200 - 1)
    res = _upload(client, _png(400, 200))
    assert res.status_code == 400
    assert res.json()["code"] == "bad_image"


def test_a_member_sets_their_own_and_sees_others(client, member_client):
    admin_id = client.get("/api/auth/state").json()["user"]["id"]
    _upload(client, _png())
    res = _upload(member_client, _png())
    assert res.status_code == 200
    assert res.json()["username"] == "member"
    # Shown next to names, so any signed-in user may fetch any picture.
    assert member_client.get(f"/api/auth/avatar/{admin_id}").status_code == 200
    users = {u["username"]: u for u in client.get("/api/users").json()}
    assert users["member"]["avatar_version"] == res.json()["avatar_version"]


def test_remove_clears_the_picture(client):
    me = client.get("/api/auth/state").json()["user"]
    before = _upload(client, _png()).json()["avatar_version"]
    res = client.delete("/api/auth/avatar")
    assert res.status_code == 200
    assert res.json()["avatar_version"] is None
    assert client.get(f"/api/auth/avatar/{me['id']}").status_code == 404
    assert list(get_paths().avatars.iterdir()) == []

    # A new picture after a removal must not reuse the old URL, which browsers
    # cache as immutable.
    after = _upload(client, _png()).json()["avatar_version"]
    assert after > before


def test_anonymous_cannot_read_or_write(client, anon_client):
    me = client.get("/api/auth/state").json()["user"]
    _upload(client, _png())
    assert anon_client.get(f"/api/auth/avatar/{me['id']}").status_code == 401
    assert _upload(anon_client, _png()).status_code == 401


def test_deleting_a_user_removes_their_picture(client, member_client):
    member = member_client.get("/api/auth/state").json()["user"]
    version = _upload(member_client, _png()).json()["avatar_version"]
    path = get_paths().avatars / f"{member['id']}_{version}.jpg"
    assert path.is_file()
    assert client.delete(f"/api/users/{member['id']}").status_code == 204
    assert not path.exists()
