"""Uploads are streamed with a byte cap, checked by content, and counted."""

from __future__ import annotations

import shutil
from io import BytesIO

import pytest
from PIL import Image

from app.services import uploads


def _png(size=(40, 30)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, (10, 120, 200)).save(buf, "PNG")
    return buf.getvalue()


def _woff2() -> bytes:
    return b"wOF2" + b"\x00" * 64


# --- fonts -------------------------------------------------------------------------


def test_font_upload_validates_magic_bytes(client, init_db):
    ok = client.post("/api/fonts", files={"file": ("a.woff2", _woff2())})
    assert ok.status_code == 200

    fake = client.post(
        "/api/fonts", files={"file": ("a.ttf", b"<html>not a font</html>")}
    )
    mismatch = client.post("/api/fonts", files={"file": ("a.otf", _woff2())})
    empty = client.post("/api/fonts", files={"file": ("a.woff", b"")})

    assert fake.status_code == 400
    assert mismatch.status_code == 400
    assert empty.status_code == 400
    listed = client.get("/api/fonts").json()["items"]
    assert len(listed) == 1  # rejected uploads leave nothing behind


@pytest.mark.parametrize(
    ("ext", "magic"),
    [(".ttf", b"\x00\x01\x00\x00"), (".otf", b"OTTO"), (".woff", b"wOFF")],
)
def test_other_font_formats_are_accepted(client, init_db, ext, magic):
    resp = client.post("/api/fonts", files={"file": (f"f{ext}", magic + b"\x00" * 32)})

    assert resp.status_code == 200


def test_oversize_font_is_413_from_the_handler(client, init_db, monkeypatch):
    monkeypatch.setattr(uploads, "FONT_MAX_BYTES", 1000)

    resp = client.post(
        "/api/fonts", files={"file": ("a.woff2", _woff2() + b"\x00" * 2000)}
    )

    assert resp.status_code == 413
    assert client.get("/api/fonts").json()["items"] == []


def test_stored_fonts_are_capped(client, init_db, monkeypatch):
    monkeypatch.setattr(uploads, "MAX_STORED_FONTS", 2)

    codes = [
        client.post("/api/fonts", files={"file": (f"{i}.woff2", _woff2())}).status_code
        for i in range(3)
    ]

    assert codes == [200, 200, 400]


# --- backgrounds -----------------------------------------------------------------------


def test_background_images_are_decoded_not_trusted(client, init_db):
    ok = client.post("/api/backgrounds", files={"file": ("b.png", _png())})
    assert ok.status_code == 200

    html_as_png = client.post(
        "/api/backgrounds", files={"file": ("b.png", b"<script>alert(1)</script>")}
    )
    png_as_jpg = client.post("/api/backgrounds", files={"file": ("b.jpg", _png())})
    bad_webm = client.post("/api/backgrounds", files={"file": ("b.webm", b"RIFFxxxx")})
    good_webm = client.post(
        "/api/backgrounds",
        files={"file": ("b.webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 16)},
    )

    assert html_as_png.status_code == 400
    assert png_as_jpg.status_code == 400
    assert bad_webm.status_code == 400
    assert good_webm.status_code == 200
    assert len(client.get("/api/backgrounds").json()["items"]) == 2


def test_oversize_background_is_413(client, init_db, monkeypatch):
    monkeypatch.setattr(uploads, "BACKGROUND_MAX_BYTES", 1000)

    resp = client.post("/api/backgrounds", files={"file": ("b.png", _png((600, 600)))})

    assert resp.status_code == 413


def test_stored_backgrounds_are_capped(client, init_db, monkeypatch):
    monkeypatch.setattr(uploads, "MAX_STORED_BACKGROUNDS", 1)

    first = client.post("/api/backgrounds", files={"file": ("b.png", _png())})
    second = client.post("/api/backgrounds", files={"file": ("c.png", _png())})

    assert (first.status_code, second.status_code) == (200, 400)


# --- thumbnails and covers --------------------------------------------------------------


def test_thumbnail_upload_is_reencoded_as_jpeg(client, add_video):
    video = add_video()

    resp = client.post(
        f"/api/videos/{video.id}/thumbnail", files={"file": ("t.png", _png())}
    )

    assert resp.status_code == 200
    served = client.get(f"/api/thumbnails/{video.id}")
    assert served.content[:3] == b"\xff\xd8\xff"
    assert Image.open(BytesIO(served.content)).format == "JPEG"


def test_non_image_thumbnail_is_rejected(client, add_video, init_db):
    video = add_video()

    for name, data in (
        ("t.png", b"<svg onload=alert(1)>"),
        ("t.jpg", b"GIF89a"),
        ("t.html", b"<html></html>"),
    ):
        resp = client.post(
            f"/api/videos/{video.id}/thumbnail", files={"file": (name, data)}
        )
        assert resp.status_code == 400, name
    assert client.get(f"/api/thumbnails/{video.id}").status_code == 404


def test_oversize_thumbnail_is_413(client, add_video, monkeypatch):
    monkeypatch.setattr(uploads, "IMAGE_MAX_BYTES", 500)
    video = add_video()

    small_over = client.post(
        f"/api/videos/{video.id}/thumbnail", files={"file": ("t.png", _png((300, 300)))}
    )

    assert small_over.status_code == 413  # handler


def test_playlist_cover_is_validated_and_capped(client, monkeypatch):
    pid = client.post("/api/playlists", json={"name": "Mix"}).json()["id"]

    bad = client.post(
        f"/api/playlists/{pid}/thumbnail", files={"file": ("c.png", b"nope")}
    )
    ok = client.post(
        f"/api/playlists/{pid}/thumbnail", files={"file": ("c.png", _png())}
    )
    monkeypatch.setattr(uploads, "IMAGE_MAX_BYTES", 500)
    big = client.post(
        f"/api/playlists/{pid}/thumbnail", files={"file": ("c.png", _png((300, 300)))}
    )

    assert (bad.status_code, ok.status_code, big.status_code) == (400, 200, 413)
    cover = client.get(f"/api/playlists/{pid}/thumbnail")
    assert Image.open(BytesIO(cover.content)).format == "JPEG"


# --- video import ---------------------------------------------------------------------------


def test_video_import_respects_the_configured_cap(client, init_db, monkeypatch):
    monkeypatch.setenv("HORDE_MAX_UPLOAD_GB", "0.001")  # ~1 MB
    payload = b"\x00" * (uploads.max_video_upload_bytes() + 1000)

    resp = client.post("/api/review/upload", files={"file": ("clip.mp4", payload)})

    assert resp.status_code == 413
    assert not list((init_db["downloads"] / "imports").glob("*"))


def test_max_upload_gb_defaults_to_fifty(monkeypatch):
    monkeypatch.delenv("HORDE_MAX_UPLOAD_GB", raising=False)
    assert uploads.max_video_upload_bytes() == 50 * 1024**3
    monkeypatch.setenv("HORDE_MAX_UPLOAD_GB", "bogus")
    assert uploads.max_video_upload_bytes() == 50 * 1024**3


def test_video_import_keeps_headroom_free(client, init_db, monkeypatch):
    real = shutil.disk_usage

    def tight(path):
        usage = real(path)
        free = uploads.IMPORT_HEADROOM_BYTES + 500
        return type(usage)(usage.total, usage.total - free, free)

    monkeypatch.setattr(uploads.shutil, "disk_usage", tight)

    resp = client.post(
        "/api/review/upload", files={"file": ("clip.mp4", b"\x00" * 5000)}
    )

    assert resp.status_code == 507
    assert not list((init_db["downloads"] / "imports").glob("*"))
