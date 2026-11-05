"""Import queue suggestions from files on disk, approve-all and YouTube lookup."""

import json
from pathlib import Path

import pytest

from app.models import Video
from app.services import import_suggest, metadata_sync


def _review_item(add_video, file_path: str, **fields) -> Video:
    return add_video(
        title=Path(file_path).stem,
        channel=None,
        needs_review=True,
        file_path=file_path,
        write_file=True,
        **fields,
    )


def _queue(client) -> dict[int, dict]:
    resp = client.get("/api/review")
    assert resp.status_code == 200
    return {row["id"]: row for row in resp.json()["items"]}


def test_horde_layout_suggests_channel_title_and_youtube_source(client, add_video):
    video = _review_item(add_video, "Veritasium/2024/Why Clocks Tick [abcdefghijk].mp4")

    suggestion = _queue(client)[video.id]["suggestion"]

    assert suggestion["title"] == "Why Clocks Tick"
    assert suggestion["channel"] == "Veritasium"
    assert suggestion["source_url"] == "https://www.youtube.com/watch?v=abcdefghijk"
    assert suggestion["thumbnail_url"] == (
        "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"
    )
    assert suggestion["sources"] == ["path"]


def test_imports_folder_and_year_folders_are_not_channels(client, add_video):
    upload = _review_item(add_video, "imports/holiday.mp4")
    year = _review_item(add_video, "2019/clip.mp4")

    queue = _queue(client)

    assert queue[upload.id]["suggestion"] is None
    assert queue[year.id]["suggestion"] is None


def test_ytdlp_info_json_wins_over_the_path(client, add_video, init_db):
    rel = "Some Folder/Odd name [abcdefghijk].mkv"
    video = _review_item(add_video, rel)
    info = {
        "id": "abcdefghijk",
        "extractor_key": "Youtube",
        "title": "The Real Title: Part 1?",
        "channel": "Real Channel",
        "channel_url": "https://www.youtube.com/@real",
        "description": "Line one\nLine two",
        "upload_date": "20230102",
        "tags": ["physics", "", 3, "clocks"],
        "thumbnail": "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
    }
    sidecar = init_db["downloads"] / "Some Folder/Odd name [abcdefghijk].info.json"
    sidecar.write_text(json.dumps(info))

    suggestion = _queue(client)[video.id]["suggestion"]

    assert suggestion["title"] == "The Real Title: Part 1?"
    assert suggestion["channel"] == "Real Channel"
    assert suggestion["channel_url"] == "https://www.youtube.com/@real"
    assert suggestion["description"] == "Line one\nLine two"
    assert suggestion["published_at"].startswith("2023-01-02")
    assert suggestion["tags"] == ["physics", "clocks"]
    assert suggestion["thumbnail_url"].endswith("maxresdefault.jpg")
    assert suggestion["sources"] == ["info_json"]


def test_kodi_nfo_is_read(client, add_video, init_db):
    video = _review_item(add_video, "Shows/episode.mp4")
    (init_db["downloads"] / "Shows/episode.nfo").write_text(
        "<?xml version='1.0'?><episodedetails><title>Episode One</title>"
        "<showtitle>Nfo Channel</showtitle><plot>About it</plot>"
        "<aired>2022-05-06</aired><tag>a</tag><tag>b</tag>"
        "<uniqueid type='youtube'>bcdefghijkl</uniqueid></episodedetails>"
    )

    suggestion = _queue(client)[video.id]["suggestion"]

    assert suggestion["title"] == "Episode One"
    assert suggestion["channel"] == "Nfo Channel"
    assert suggestion["description"] == "About it"
    assert suggestion["published_at"].startswith("2022-05-06")
    assert suggestion["tags"] == ["a", "b"]
    assert suggestion["source_url"] == "https://www.youtube.com/watch?v=bcdefghijkl"


def test_broken_sidecars_are_ignored(client, add_video, init_db):
    video = _review_item(add_video, "Chan/2020/clip.mp4")
    (init_db["downloads"] / "Chan/2020/clip.info.json").write_text("{not json")
    (init_db["downloads"] / "Chan/2020/clip.nfo").write_text("<unclosed>")

    suggestion = _queue(client)[video.id]["suggestion"]

    assert suggestion["channel"] == "Chan"
    assert suggestion["sources"] == ["path"]


def test_fields_already_set_are_not_suggested(client, add_video):
    video = _review_item(
        add_video,
        "Veritasium/2024/Why Clocks Tick [abcdefghijk].mp4",
        description="Mine",
    )
    suggestion = _queue(client)[video.id]["suggestion"]
    assert suggestion["description"] is None


def test_approve_suggested_approves_known_items_in_place(
    client, add_video, init_db, session
):
    ready = _review_item(add_video, "Veritasium/2024/Why Clocks Tick [abcdefghijk].mp4")
    unknown = _review_item(add_video, "imports/holiday.mp4")

    resp = client.post("/api/review/approve-suggested")

    assert resp.status_code == 200
    assert resp.json() == {"approved": 1, "remaining": 1}
    session.expire_all()
    row = session.get(Video, ready.id)
    assert row is not None
    assert row.needs_review is False
    assert row.title == "Why Clocks Tick"
    assert row.channel == "Veritasium"
    assert row.source_url == "https://www.youtube.com/watch?v=abcdefghijk"
    # The file was not moved or renamed.
    assert row.file_path == "Veritasium/2024/Why Clocks Tick [abcdefghijk].mp4"
    assert (init_db["downloads"] / row.file_path).is_file()
    still = session.get(Video, unknown.id)
    assert still is not None and still.needs_review is True
    assert list(_queue(client)) == [unknown.id]


def test_lookup_on_youtube_returns_the_full_metadata(client, add_video, monkeypatch):
    video = _review_item(add_video, "Chan/2024/clip [abcdefghijk].mp4")
    asked: list[str] = []

    def fake_extract(url, *, priority):
        asked.append(url)
        return {
            "title": "From YouTube",
            "channel": "Tube Channel",
            "upload_date": "20240514",
            "description": "Desc",
            "tags": ["x"],
            "webpage_url": url,
            "thumbnail": "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
        }

    monkeypatch.setattr(metadata_sync, "extract_source_info", fake_extract)

    resp = client.get(f"/api/review/{video.id}/youtube")

    assert resp.status_code == 200
    body = resp.json()
    assert asked == ["https://www.youtube.com/watch?v=abcdefghijk"]
    assert body["title"] == "From YouTube"
    assert body["channel"] == "Tube Channel"
    assert body["description"] == "Desc"
    assert body["sources"] == ["youtube"]


def test_lookup_needs_a_youtube_id(client, add_video):
    video = _review_item(add_video, "imports/holiday.mp4")

    resp = client.get(f"/api/review/{video.id}/youtube")

    assert resp.status_code == 409
    assert resp.json()["code"] == "no_youtube_id"


def test_lookup_accepts_a_typed_youtube_id(client, add_video, monkeypatch):
    video = _review_item(add_video, "imports/holiday.mp4")
    monkeypatch.setattr(
        metadata_sync,
        "extract_source_info",
        lambda url, *, priority: {"title": "T", "webpage_url": url},
    )

    assert (
        client.get(
            f"/api/review/{video.id}/youtube", params={"youtube_id": "../etc/pass"}
        ).status_code
        == 422
    )
    resp = client.get(
        f"/api/review/{video.id}/youtube", params={"youtube_id": "abcdefghijk"}
    )
    assert resp.status_code == 200
    assert resp.json()["source_url"] == "https://www.youtube.com/watch?v=abcdefghijk"


def test_a_plain_folder_is_not_taken_for_a_channel(client, add_video):
    inbox = _review_item(add_video, "inbox/holiday.mp4")
    laid_out = _review_item(add_video, "Kiln/2021/firing.mp4")

    queue = _queue(client)

    assert queue[inbox.id]["suggestion"] is None
    assert queue[laid_out.id]["suggestion"]["channel"] == "Kiln"


def test_tube_archivist_layout_gives_the_youtube_id(client, add_video):
    video = _review_item(add_video, "UCBa659QWEk1AI4Tg--mrJ2A/2tdiKTSdE9Y.mp4")

    suggestion = _queue(client)[video.id]["suggestion"]

    assert suggestion["source_url"] == "https://www.youtube.com/watch?v=2tdiKTSdE9Y"
    assert suggestion["title"] is None
    assert suggestion["channel"] is None  # a channel id, not a name


def test_a_pathological_sidecar_costs_only_its_own_suggestion(
    client, add_video, init_db
):
    """A deeply nested .info.json raised RecursionError and broke the whole list."""
    bad = _review_item(add_video, "Chan/2020/deep [abcdefghijk].mp4")
    good = _review_item(add_video, "Kiln/2021/firing.mp4")
    (init_db["downloads"] / "Chan/2020/deep [abcdefghijk].info.json").write_text(
        "[" * 200_000 + "]" * 200_000
    )

    queue = _queue(client)

    assert queue[good.id]["suggestion"]["channel"] == "Kiln"
    # The broken sidecar is skipped; the path still speaks.
    assert queue[bad.id]["suggestion"]["channel"] == "Chan"
    assert client.post("/api/review/approve-suggested").status_code == 200


def test_bulk_approve_keeps_the_thumbnail_the_user_chose(
    client, add_video, init_db, session, monkeypatch
):
    from app.services import thumbnails

    video = _review_item(add_video, "Chan/2020/clip [abcdefghijk].mp4")
    chosen = init_db["downloads"].parent / "chosen.jpg"
    chosen.write_bytes(b"my-own-thumbnail")
    row = session.get(Video, video.id)
    assert row is not None
    row.thumbnail_path = str(chosen)
    session.add(row)
    session.commit()

    def no_network(*_a, **_k):
        raise AssertionError("bulk approve must not fetch thumbnails")

    monkeypatch.setattr(thumbnails, "save_from_url", no_network)

    assert client.post("/api/review/approve-suggested").json()["approved"] == 1
    session.expire_all()
    row = session.get(Video, video.id)
    assert row is not None and row.thumbnail_path == str(chosen)
    assert chosen.read_bytes() == b"my-own-thumbnail"


@pytest.mark.parametrize(
    ("rel", "channel"),
    [
        ("Downloads/Video [dQw4w9WgXcQ].mp4", None),
        ("YouTube/Some Channel/Video [dQw4w9WgXcQ].mp4", "Some Channel"),
        ("a/b/Veritasium/Video [dQw4w9WgXcQ].mp4", "Veritasium"),
        ("Archive/Veritasium/2024/Video [dQw4w9WgXcQ].mp4", "Veritasium"),
        ("videos/2024/Video [dQw4w9WgXcQ].mp4", None),
    ],
)
def test_the_channel_is_the_nearest_meaningful_folder(rel, channel):
    assert import_suggest._from_path(rel).get("channel") == channel


def test_a_sidecar_symlinked_outside_the_media_folder_is_not_read(
    client, add_video, init_db, tmp_path
):
    outside = tmp_path / "secret.info.json"
    outside.write_text(json.dumps({"title": "Outside secret"}))
    video = _review_item(add_video, "Chan/2020/clip.mp4")
    (init_db["downloads"] / "Chan/2020/clip.info.json").symlink_to(outside)

    suggestion = _queue(client)[video.id]["suggestion"]

    assert suggestion is not None and suggestion["title"] != "Outside secret"
