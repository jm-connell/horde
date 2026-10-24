"""Optional Jellyfin / Kodi / Plex files: the NFO, the thumbnail, when they are written."""

from __future__ import annotations

import io
import json
import threading
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlmodel import Session
from ytdlp_fakes import record_side_effects

from app import config
from app.models import TrashEntry, Video
from app.services import app_settings, media_sidecars, scanner
from app.services.downloads import finalize
from app.services.paths import (
    nfo_sidecar_path,
    thumb_sidecar_path,
)

PUBLISHED = datetime(2024, 3, 5, tzinfo=UTC)  # day 65 of a leap year


def _enable(on: bool = True) -> None:
    app_settings.save({"media_server_sidecars": on})


def _jpeg(color: str = "red") -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(out, "JPEG")
    return out.getvalue()


def _with_thumbnail(init_db, video: Video, color: str = "red") -> bytes:
    data = _jpeg(color)
    path = init_db["data"] / "thumbnails" / f"{video.id}.jpg"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    with Session(init_db["engine"]) as s:
        row = s.get(Video, video.id)
        row.thumbnail_path = str(path)
        s.add(row)
        s.commit()
    return data


def _parse(raw: bytes) -> ET.Element:
    return ET.fromstring(raw)  # noqa: S314 - the test reads back what it just wrote


def _nfo(init_db, rel: str) -> ET.Element:
    return _parse((init_db["downloads"] / rel).with_suffix(".nfo").read_bytes())


def _text(root: ET.Element, tag: str) -> str | None:
    return root.findtext(tag)


def _run_jobs(init_db) -> int:
    return init_db["ctx"].sidecars.run_pending()


def _sync(init_db, video_id: int) -> bool:
    with Session(init_db["engine"]) as s:
        return media_sidecars.sync_video(s, s.get(Video, video_id))


def _published(add_video, **kw) -> Video:
    return add_video(write_file=True, published_at=PUBLISHED, **kw)


# --- The files themselves -----------------------------------------------------


def test_episode_nfo_has_the_fields_a_media_server_reads(init_db, add_video):
    video = _published(
        add_video,
        yt_id="nfovideo001",
        title="Why A & B <rock> \"quoted\" 'too'",
        description="Line one\nLine <two> & ]]> three",
        tags=["Cats", "cats", "dogs", " "],
        duration_sec=605.0,
        channel_url="https://www.youtube.com/channel/UCabc123",
    )
    assert _sync(init_db, video.id) is True

    root = _nfo(init_db, video.file_path)
    assert root.tag == "episodedetails"
    assert _text(root, "title") == "Why A & B <rock> \"quoted\" 'too'"
    assert _text(root, "showtitle") == "Alpha"
    assert _text(root, "studio") == "Alpha"
    assert _text(root, "plot") == "Line one\nLine <two> & ]]> three"
    assert _text(root, "season") == "2024"
    assert _text(root, "episode") == "6500"  # day 65 * 100, first upload of the day
    assert _text(root, "runtime") == "10"
    assert _text(root, "aired") == _text(root, "premiered") == "2024-03-05"
    assert [e.text for e in root.findall("tag")] == ["Cats", "dogs"]
    assert [e.text for e in root.findall("genre")] == ["Cats", "dogs"]
    uid = root.find("uniqueid")
    assert uid is not None
    assert (uid.text, uid.get("type"), uid.get("default")) == (
        "nfovideo001",
        "youtube",
        "true",
    )
    assert (_text(root, "dateadded") or "")[:2] == "20"


def test_a_missing_description_and_unwritable_characters(init_db, add_video):
    video = _published(
        add_video,
        title="Bell\x07 and\x00null",
        description=None,
        file_path="Alpha/2024/bell.mp4",
    )
    _sync(init_db, video.id)

    raw = (init_db["downloads"] / video.file_path).with_suffix(".nfo").read_bytes()
    assert raw.startswith(b'<?xml version="1.0" encoding="UTF-8"')
    root = _parse(raw)  # still well-formed
    assert _text(root, "title") == "Bell andnull"
    assert root.find("plot") is None


def test_only_the_first_tags_become_genres(init_db, add_video):
    tags = [f"tag{i}" for i in range(9)]
    video = _published(add_video, tags=tags)
    _sync(init_db, video.id)

    root = _nfo(init_db, video.file_path)
    assert len(root.findall("tag")) == 9
    assert [e.text for e in root.findall("genre")] == tags[: media_sidecars.MAX_GENRES]


def test_thumbnail_copy_and_show_file(init_db, add_video):
    video = _published(
        add_video,
        channel="Veritasium",
        channel_url="https://www.youtube.com/@veritasium",
    )
    data = _with_thumbnail(init_db, video)
    _sync(init_db, video.id)

    media = init_db["downloads"] / video.file_path
    assert thumb_sidecar_path(media).read_bytes() == data
    show = _parse((init_db["downloads"] / "Veritasium" / "tvshow.nfo").read_bytes())
    assert show.tag == "tvshow"
    assert _text(show, "title") == _text(show, "studio") == "Veritasium"
    uid = show.find("uniqueid")
    assert uid is not None and uid.text == "@veritasium"
    assert show.find("plot") is None
    assert not (init_db["downloads"] / "Veritasium" / "poster.jpg").exists()


def test_files_are_only_rewritten_when_the_content_changes(init_db, add_video):
    video = _published(add_video)
    _with_thumbnail(init_db, video)
    assert _sync(init_db, video.id) is True
    nfo = nfo_sidecar_path(init_db["downloads"] / video.file_path)
    before = nfo.stat().st_mtime_ns

    assert _sync(init_db, video.id) is False
    assert nfo.stat().st_mtime_ns == before

    with Session(init_db["engine"]) as s:
        row = s.get(Video, video.id)
        row.title = "New title"
        s.add(row)
        s.commit()
    assert _sync(init_db, video.id) is True
    assert _text(_parse(nfo.read_bytes()), "title") == "New title"
    assert not list(nfo.parent.glob(".*.tmp"))  # no temp file left behind


def test_episode_numbers_are_stable_within_a_day(init_db, add_video):
    first = _published(add_video, yt_id="sameday0001")
    second = _published(add_video, yt_id="sameday0002")
    other_channel = _published(add_video, yt_id="sameday0003", channel="Beta")
    for video in (first, second, other_channel):
        _sync(init_db, video.id)

    numbers = [
        _text(_nfo(init_db, v.file_path), "episode")
        for v in (first, second, other_channel)
    ]
    assert numbers == ["6500", "6501", "6500"]

    # A later upload of the same day never renumbers the earlier ones.
    third = _published(add_video, yt_id="sameday0004")
    _sync(init_db, third.id)
    assert _text(_nfo(init_db, third.file_path), "episode") == "6502"
    assert _sync(init_db, first.id) is False


def test_videos_in_review_and_without_media_get_nothing(init_db, add_video):
    reviewing = add_video(write_file=True, needs_review=True, published_at=PUBLISHED)
    missing = add_video(write_file=False, published_at=PUBLISHED)
    assert _sync(init_db, reviewing.id) is False
    assert _sync(init_db, missing.id) is False
    assert not list(init_db["downloads"].rglob("*.nfo"))


def test_nothing_is_written_outside_the_library(init_db, add_video, caplog):
    outside = init_db["downloads"].parent / "outside"
    outside.mkdir()
    (outside / "x.mp4").write_bytes(b"\x00")
    video = add_video(file_path="../outside/x.mp4", published_at=PUBLISHED)
    _enable()

    with caplog.at_level("WARNING"):
        media_sidecars.refresh(video.id)

    assert not list(outside.glob("*.nfo"))
    assert "could not write the media-server files" in caplog.text


# --- When they are written ----------------------------------------------------


def test_the_setting_is_admin_only_and_off_by_default(client, member_client, init_db):
    assert client.get("/api/settings").json()["media_server_sidecars"] is False
    assert (
        member_client.patch(
            "/api/settings", json={"media_server_sidecars": True}
        ).status_code
        == 403
    )
    resp = client.patch("/api/settings", json={"media_server_sidecars": True})
    assert resp.status_code == 200
    assert resp.json()["media_server_sidecars"] is True
    # Members get the default, not the server's choice.
    assert member_client.get("/api/settings").json()["media_server_sidecars"] is False


def test_turning_it_on_backfills_the_library(client, init_db, add_video):
    one = _published(add_video, yt_id="backfill0001")
    two = _published(add_video, yt_id="backfill0002", channel="Beta")
    reviewing = add_video(write_file=True, needs_review=True, channel=None)
    _with_thumbnail(init_db, one)

    assert (
        client.patch("/api/settings", json={"media_server_sidecars": True}).status_code
        == 200
    )
    assert init_db["ctx"].sidecars.pending() == 1
    assert not list(
        init_db["downloads"].rglob("*.nfo")
    )  # nothing before the worker runs

    assert _run_jobs(init_db) == 1

    for video in (one, two):
        assert nfo_sidecar_path(init_db["downloads"] / video.file_path).is_file()
    assert thumb_sidecar_path(init_db["downloads"] / one.file_path).is_file()
    assert (init_db["downloads"] / "Alpha" / "tvshow.nfo").is_file()
    assert (init_db["downloads"] / "Beta" / "tvshow.nfo").is_file()
    assert not nfo_sidecar_path(init_db["downloads"] / reviewing.file_path).exists()

    # Saving "on" again is not a reason to walk the library again.
    assert (
        client.patch("/api/settings", json={"media_server_sidecars": True}).status_code
        == 200
    )
    assert init_db["ctx"].sidecars.pending() == 0


def test_a_backfill_stops_when_the_setting_is_switched_off(init_db, add_video):
    video = _published(add_video)
    _enable()
    init_db["ctx"].sidecars.write_all()
    _enable(False)

    _run_jobs(init_db)

    assert not nfo_sidecar_path(init_db["downloads"] / video.file_path).exists()


def test_a_finished_download_writes_them_only_when_on(init_db, add_video, monkeypatch):
    record_side_effects(monkeypatch)
    video = add_video(write_file=True, published_at=PUBLISHED)
    media = init_db["downloads"] / video.file_path

    def finish() -> None:
        finalize.finalize_in_background(
            video.id, media, "https://example.com/v", "https://t.example/a.jpg", None
        )
        for thread in threading.enumerate():
            if thread.name == f"finalize-{video.id}":
                thread.join(10)

    finish()
    assert not nfo_sidecar_path(media).exists()

    _enable()
    finish()
    assert nfo_sidecar_path(media).is_file()


def test_editing_a_video_rewrites_its_files(client, init_db, add_video):
    video = _published(add_video, title="Before", description="old")
    _with_thumbnail(init_db, video, "red")
    _enable()
    _sync(init_db, video.id)
    media = init_db["downloads"] / video.file_path

    resp = client.patch(
        f"/api/videos/{video.id}",
        json={"title": "After", "description": "new", "tags": ["fresh"]},
    )
    assert resp.status_code == 200
    root = _parse(nfo_sidecar_path(media).read_bytes())
    assert _text(root, "title") == "After"
    assert _text(root, "plot") == "new"
    assert [e.text for e in root.findall("tag")] == ["fresh"]

    resp = client.post(
        f"/api/videos/{video.id}/thumbnail",
        files={"file": ("t.jpg", _jpeg("blue"), "image/jpeg")},
    )
    assert resp.status_code == 200
    stored = client.get(f"/api/thumbnails/{video.id}").content
    assert thumb_sidecar_path(media).read_bytes() == stored


def test_editing_writes_nothing_while_the_setting_is_off(client, init_db, add_video):
    video = _published(add_video)
    assert (
        client.patch(f"/api/videos/{video.id}", json={"title": "x"}).status_code == 200
    )
    assert not list(init_db["downloads"].rglob("*.nfo"))


def test_a_metadata_refresh_rewrites_them(init_db, add_video, monkeypatch):
    from app.services import metadata_sync

    video = _published(add_video, source_url="https://www.youtube.com/watch?v=abc")
    _enable()
    _sync(init_db, video.id)
    monkeypatch.setattr(
        metadata_sync,
        "_extract_metadata",
        lambda url: {"title": "Renamed upstream", "description": "from the source"},
    )

    metadata_sync.refresh_video_metadata(video.id)

    root = _nfo(init_db, video.file_path)
    assert _text(root, "title") == "Renamed upstream"
    assert _text(root, "plot") == "from the source"


def test_a_channel_rename_rewrites_the_files_of_its_videos(client, init_db, add_video):
    video = _published(add_video, channel="Old name")
    _enable()
    _sync(init_db, video.id)

    resp = client.patch(
        "/api/channels", json={"old_name": "Old name", "new_name": "New name"}
    )
    assert resp.status_code == 200
    _run_jobs(init_db)

    root = _nfo(init_db, video.file_path)
    assert _text(root, "showtitle") == _text(root, "studio") == "New name"
    # The downloaded file stays where it is; the show file follows the new name.
    assert (init_db["downloads"] / video.file_path).is_file()
    show = _parse((init_db["downloads"] / "Old name" / "tvshow.nfo").read_bytes())
    assert _text(show, "title") == "New name"


def test_moving_a_manual_import_moves_its_files(client, init_db, add_video):
    video = add_video(
        write_file=True,
        channel="Old",
        title="Clip",
        file_path="Old/Clip.mp4",
        published_at=PUBLISHED,
    )
    _with_thumbnail(init_db, video)
    _enable()
    _sync(init_db, video.id)
    old = init_db["downloads"] / "Old" / "Clip.mp4"
    assert nfo_sidecar_path(old).is_file() and thumb_sidecar_path(old).is_file()

    resp = client.patch(f"/api/videos/{video.id}", json={"channel": "New"})
    assert resp.status_code == 200

    new = init_db["downloads"] / "New" / "Clip.mp4"
    assert new.is_file()
    assert not nfo_sidecar_path(old).exists() and not thumb_sidecar_path(old).exists()
    assert thumb_sidecar_path(new).is_file()
    root = _parse(nfo_sidecar_path(new).read_bytes())
    assert _text(root, "showtitle") == "New"
    assert (init_db["downloads"] / "New" / "tvshow.nfo").is_file()


# --- Deleting, trashing, restoring --------------------------------------------


def _with_files(init_db, add_video) -> tuple[Video, Path]:
    video = _published(add_video, yt_id="sidecardel01")
    _with_thumbnail(init_db, video)
    _enable()
    _sync(init_db, video.id)
    media = init_db["downloads"] / video.file_path
    assert nfo_sidecar_path(media).is_file() and thumb_sidecar_path(media).is_file()
    return video, media


def test_deleting_the_file_deletes_its_sidecars(client, init_db, add_video):
    video, media = _with_files(init_db, add_video)

    assert client.delete(f"/api/videos/{video.id}?delete_file=true").status_code == 204

    assert not media.exists()
    assert not nfo_sidecar_path(media).exists()
    assert not thumb_sidecar_path(media).exists()


def test_deleting_only_the_library_entry_keeps_them(client, init_db, add_video):
    video, media = _with_files(init_db, add_video)

    assert client.delete(f"/api/videos/{video.id}").status_code == 204

    assert media.exists() and nfo_sidecar_path(media).exists()


def test_trash_takes_the_sidecars_along_and_restore_brings_them_back(
    client, init_db, add_video, monkeypatch
):
    monkeypatch.setattr(config, "TRASH_DAYS", 7)
    video, media = _with_files(init_db, add_video)
    nfo_bytes = nfo_sidecar_path(media).read_bytes()

    resp = client.delete(f"/api/videos/{video.id}?delete_file=true")
    assert resp.status_code == 204
    entry_id = int(resp.headers["x-horde-trash-entry"])

    assert not nfo_sidecar_path(media).exists()
    assert not thumb_sidecar_path(media).exists()
    with Session(init_db["engine"]) as s:
        entry = s.get(TrashEntry, entry_id)
        listed = {f["path"] for f in json.loads(entry.files_json)}
    rel = media.relative_to(init_db["downloads"])
    assert nfo_sidecar_path(rel).as_posix() in listed
    assert thumb_sidecar_path(rel).as_posix() in listed

    assert client.post(f"/api/trash/{entry_id}/restore").status_code == 200

    assert nfo_sidecar_path(media).read_bytes() == nfo_bytes
    assert thumb_sidecar_path(media).is_file()


# --- Keeping them out of the library ------------------------------------------


def test_the_scanner_does_not_take_them_for_media(client, init_db, monkeypatch):
    monkeypatch.setattr(scanner, "probe_is_playable", lambda _p: True)
    monkeypatch.setattr(scanner, "_is_stable", lambda _p: True)
    folder = init_db["downloads"] / "Chan" / "2024"
    folder.mkdir(parents=True)
    for name in ("A [x].nfo", "A [x]-thumb.jpg", "tvshow.nfo", "poster.jpg"):
        target = (
            folder.parent / name
            if name in ("tvshow.nfo", "poster.jpg")
            else folder / name
        )
        target.write_bytes(b"\x00" * 64)

    assert client.post("/api/review/scan").json()["added"] == 0
    assert client.get("/api/review").json()["items"] == []


# --- Removing them ------------------------------------------------------------


def test_remove_deletes_every_file_but_not_the_media(client, init_db, add_video):
    video, media = _with_files(init_db, add_video)
    show = init_db["downloads"] / "Alpha" / "tvshow.nfo"
    assert show.is_file()

    # Still on: refused, because the files would just be written again.
    resp = client.post("/api/settings/media-sidecars/remove")
    assert resp.status_code == 409
    assert resp.json()["code"] == "media_sidecars_enabled"

    _enable(False)
    resp = client.post("/api/settings/media-sidecars/remove")
    assert resp.status_code == 202
    assert resp.json() == {"queued": True}
    assert nfo_sidecar_path(media).exists()  # in the background, not in the request

    _run_jobs(init_db)

    assert media.is_file()
    assert not nfo_sidecar_path(media).exists()
    assert not thumb_sidecar_path(media).exists()
    assert not show.exists()


def test_turning_it_off_leaves_the_files_in_place(client, init_db, add_video):
    video, media = _with_files(init_db, add_video)

    assert (
        client.patch("/api/settings", json={"media_server_sidecars": False}).status_code
        == 200
    )
    _run_jobs(init_db)

    assert nfo_sidecar_path(media).is_file()


def test_only_an_administrator_may_remove_them(member_client):
    assert member_client.post("/api/settings/media-sidecars/remove").status_code == 403


@pytest.mark.parametrize("kind", ["write", "remove"])
def test_a_job_that_fails_does_not_stop_the_worker(
    init_db, add_video, monkeypatch, kind
):
    _published(add_video)
    _enable()
    jobs = init_db["ctx"].sidecars

    def broken(*_args):
        raise OSError("disk")

    monkeypatch.setattr(media_sidecars, "_video_ids", broken)
    if kind == "write":
        jobs.write_all()
    else:
        jobs.remove_all()

    assert jobs.run_pending() == 1
    assert jobs.pending() == 0
