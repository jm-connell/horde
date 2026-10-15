"""A failed download must never delete or adopt another video's files.

Regression for the ``_video_stem`` bug: titles containing ``.f`` (``Learn.fast
tricks``, ``www.facebook.com``) were cut at the first ``.f`` and every file in
the folder starting with that prefix was treated as part of the download.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from yt_dlp.utils import prepend_extension

from app.services import downloader
from app.services.paths import (
    FRAGMENT_RE,
    belongs_to_stem,
    video_stem,
)

TITLES = [
    "Learn.fast tricks",
    "Intro.f2 remix",
    "Dr.Fox interview",
    "www.facebook.com guide",
    "Plain title",
    "Learn.fast",
]


def _touch(path: Path, size: int = 64) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00" * size)
    return path


@pytest.mark.parametrize(
    "fmt_id", ["137", "251-drc", "140-0", "hls-1080p", "http-720p"]
)
@pytest.mark.parametrize("title", TITLES)
def test_video_stem_inverts_yt_dlp_format_suffix(title, fmt_id):
    # Build the name exactly like yt-dlp does for a per-format download.
    base = f"/x/{title} [dQw4w9WgXcQ].mp4"
    fragment = prepend_extension(base, f"f{fmt_id}", "mp4")
    assert FRAGMENT_RE.search(Path(fragment).name)
    assert video_stem(Path(fragment)) == f"{title} [dQw4w9WgXcQ]"
    assert video_stem(Path(base)) == f"{title} [dQw4w9WgXcQ]"
    assert not FRAGMENT_RE.search(Path(base).name)


def test_belongs_to_stem_is_exact_not_prefix():
    stem = "Learn [aaaaaaaaaaa]"
    assert belongs_to_stem("Learn [aaaaaaaaaaa].mp4", stem)
    assert belongs_to_stem("Learn [aaaaaaaaaaa].f137.mp4.part", stem)
    assert belongs_to_stem("Learn [aaaaaaaaaaa].en.vtt", stem)
    assert belongs_to_stem("Learn [aaaaaaaaaaa].horde-h264.mp4", stem)
    assert not belongs_to_stem("Learn [aaaaaaaaaaab].mp4", stem)
    assert not belongs_to_stem("Learn [aaaaaaaaaaa] part two [bbbbbbbbbbb].mp4", stem)
    assert not belongs_to_stem("Learn.mp4", stem)
    assert not belongs_to_stem("anything.mp4", "")


@pytest.mark.parametrize("title", TITLES)
def test_failed_download_cleanup_spares_sibling_videos(init_db, title):
    folder = init_db["downloads"] / "Chan" / "2024"
    target = f"{title} [dQw4w9WgXcQ]"
    first_word = title.split(".")[0].split(" ")[0]
    siblings = [
        _touch(folder / f"{first_word} [sibling0001].mp4"),
        _touch(folder / f"{first_word} other thing [sibling0002].mp4"),
        _touch(folder / f"{title} [dQw4w9WgXcQ] extended [sibling0003].mp4"),
        _touch(folder / f"{title} [dQw4w9WgXcQ] extended [sibling0003].en.vtt"),
    ]
    mine = [
        _touch(folder / f"{target}.mp4"),
        _touch(folder / f"{target}.f137.mp4"),
        _touch(folder / f"{target}.f140.m4a"),
        _touch(folder / f"{target}.f137.mp4.part"),
    ]
    rel = (folder / f"{target}.mp4").relative_to(init_db["downloads"]).as_posix()

    downloader._cleanup_download_artifacts({rel}, remove_final=True)

    assert not any(p.exists() for p in mine)
    assert all(p.exists() for p in siblings)


@pytest.mark.parametrize("title", TITLES)
def test_find_merged_video_never_adopts_a_sibling(init_db, title):
    folder = init_db["downloads"] / "Chan" / "2024"
    target = f"{title} [dQw4w9WgXcQ]"
    first_word = title.split(".")[0].split(" ")[0]
    # A much larger sibling that shares the visible prefix.
    _touch(folder / f"{first_word} [sibling0001].mp4", size=4096)
    _touch(folder / f"{title} [dQw4w9WgXcQ] extended [sibling0003].mp4", size=4096)
    prepared = folder / f"{target}.webm"

    # Nothing of ours exists yet, only fragments: there is no merged file.
    _touch(folder / f"{target}.f137.mp4")
    _touch(folder / f"{target}.f251.webm")
    assert downloader._find_merged_video(prepared) is None

    merged = _touch(folder / f"{target}.mkv", size=128)
    assert downloader._find_merged_video(prepared) == merged


def test_reject_unplayable_removes_only_the_failed_download(init_db, monkeypatch):
    folder = init_db["downloads"] / "Chan" / "2024"
    target = "Learn.fast tricks [dQw4w9WgXcQ]"
    sibling = _touch(folder / "Learn [sibling0001].mp4")
    broken = _touch(folder / f"{target}.mp4")
    part = _touch(folder / f"{target}.f137.mp4.part")
    monkeypatch.setattr(downloader, "_validate_playable", lambda _p: False)

    rel = broken.relative_to(init_db["downloads"]).as_posix()
    assert downloader._reject_unplayable(broken, {rel}) is None

    assert not broken.exists()
    assert not part.exists()
    assert sibling.exists()


def test_subtitle_collection_ignores_other_videos(init_db, monkeypatch):
    folder = init_db["downloads"] / "Chan"
    media = _touch(folder / "Learn.fast [dQw4w9WgXcQ].mp4")
    _touch(folder / "Learn.fast [dQw4w9WgXcQ].en.vtt")
    _touch(folder / "Learn.fast [dQw4w9WgXcQ].de-DE.vtt")
    _touch(folder / "Learn.fast [dQw4w9WgXcQ] extended [sibling0003].en.vtt")
    _touch(folder / "Learn [sibling0001].fr.vtt")
    tracks = downloader._collect_subtitles(media)
    assert sorted(t["lang"] for t in tracks) == ["de", "en"]


@pytest.mark.parametrize(
    "name",
    ["Movie [2020].final.mp4", "Movie [2020].fixed.mp4", "x [1080p].fps60.mp4"],
)
def test_scanner_imports_user_files_that_look_vaguely_like_fragments(
    init_db, monkeypatch, name
):
    from sqlmodel import Session, select

    from app.models import Video
    from app.services import scanner

    path = _touch(init_db["downloads"] / "Library" / name, size=2048)
    assert not FRAGMENT_RE.search(name)
    assert scanner._is_media(path)
    monkeypatch.setattr(scanner, "probe_is_playable", lambda _p: True)
    monkeypatch.setattr(scanner, "probe_dimensions", lambda _p: (640, 360))
    monkeypatch.setattr(scanner, "probe_duration", lambda _p: 10.0)
    monkeypatch.setattr(scanner, "probe_frame_rate", lambda _p: 30.0)
    monkeypatch.setattr(scanner, "grab_frame", lambda *_a, **_k: False)
    monkeypatch.setattr("app.services.media_info.probe_stream_info", lambda _p: None)
    monkeypatch.setattr(
        "app.services.sprites.enqueue_sprite_generation", lambda *a, **k: None
    )
    with Session(init_db["engine"]) as s:
        assert scanner.ingest_media_file(s, path, require_stable=False) is not None
        assert s.exec(select(Video)).one().file_path == f"Library/{name}"


@pytest.mark.parametrize(
    "fmt_id", ["137", "251-drc", "hls-1080p", "dash-video-1", "http-720p"]
)
def test_real_yt_dlp_fragments_are_still_ignored_by_the_scanner(init_db, fmt_id):
    from app.services import scanner

    name = f"Clip [dQw4w9WgXcQ].f{fmt_id}.mp4"
    assert scanner._is_media(_touch(init_db["downloads"] / "C" / name)) is False


def test_staging_scope_accepts_any_format_id():
    from app.services.paths import STAGING_FRAGMENT_RE

    assert STAGING_FRAGMENT_RE.search("Clip [dQw4w9WgXcQ].fmp4-1080.mp4")
    assert video_stem(Path("Clip [dQw4w9WgXcQ].fmp4-1080.mp4"), staging=True) == (
        "Clip [dQw4w9WgXcQ]"
    )
    assert video_stem(Path("Movie [2020].final.mp4")) == "Movie [2020].final"
