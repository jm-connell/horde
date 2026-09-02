"""List-size thumbnail generation and the ?size=sm endpoint."""

from io import BytesIO

from PIL import Image


def test_write_list_thumbnail_downscales(init_db):
    from app.config import THUMBNAILS_DIR
    from app.services.thumbnails import (
        LIST_THUMB_MAX_PX,
        full_path,
        list_path,
        write_list_thumbnail,
    )

    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
    full = full_path(1)
    Image.new("RGB", (1280, 720), (10, 20, 30)).save(full, "JPEG")
    assert write_list_thumbnail(1, full)
    sm = Image.open(list_path(1))
    assert sm.size[0] <= LIST_THUMB_MAX_PX
    assert sm.size[1] <= LIST_THUMB_MAX_PX
    assert sm.size == (320, 180)


def test_list_thumbnail_endpoint_generates_sm(client, add_video, session):
    from app.config import THUMBNAILS_DIR

    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
    video = add_video()
    full = THUMBNAILS_DIR / f"{video.id}.jpg"
    Image.new("RGB", (1280, 720), (10, 20, 30)).save(full, quality=95)
    video.thumbnail_path = str(full)
    session.add(video)
    session.commit()

    full_resp = client.get(f"/api/thumbnails/{video.id}")
    assert full_resp.status_code == 200
    sm_resp = client.get(f"/api/thumbnails/{video.id}", params={"size": "sm"})
    assert sm_resp.status_code == 200
    sm = Image.open(BytesIO(sm_resp.content))
    assert sm.size == (320, 180)
    assert len(sm_resp.content) < len(full_resp.content)


def test_unknown_thumbnail_size_is_rejected(client, add_video, session):
    from app.config import THUMBNAILS_DIR

    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
    video = add_video()
    full = THUMBNAILS_DIR / f"{video.id}.jpg"
    Image.new("RGB", (64, 36), (1, 2, 3)).save(full, "JPEG")
    video.thumbnail_path = str(full)
    session.add(video)
    session.commit()

    resp = client.get(f"/api/thumbnails/{video.id}", params={"size": "tiny"})
    assert resp.status_code == 400
