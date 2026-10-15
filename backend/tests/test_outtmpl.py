"""Output-template helpers: channel folder choice and length fitting."""

from __future__ import annotations

import os
from pathlib import Path

import yt_dlp

from app.services.outtmpl import (
    NAME_SUFFIX_RESERVE,
    channel_folder,
    fit_outtmpl,
    library_outtmpl,
    windows_filenames_ok,
)


def test_channel_folder_prefers_override_then_uploader_then_channel():
    info = {"uploader": "Up", "channel": "Ch", "uploader_id": "@id"}
    assert channel_folder(info, "Override") == "Override"
    assert channel_folder(info) == "Up"
    assert channel_folder({"channel": "Ch"}) == "Ch"
    assert channel_folder({"uploader_id": "@id"}) == "@id"
    assert channel_folder({}) == "Unknown channel"
    assert channel_folder({"uploader": "  "}, "  ") == "Unknown channel"


def test_channel_folder_matches_yt_dlp_field_sanitising():
    # The template used to render %(uploader)s, so existing folders keep names.
    assert channel_folder({"uploader": "AC/DC"}) == "AC⧸DC"
    assert channel_folder({"uploader": "Why?"}) == "Why？"


def test_template_escapes_percent_in_literal_parts():
    tmpl = library_outtmpl(Path("/data/100%"), "50% Off")
    ydl = yt_dlp.YoutubeDL({"quiet": True})
    out = ydl.prepare_filename({"id": "x", "title": "t", "ext": "mp4"}, outtmpl=tmpl)
    assert out.startswith("/data/100%/50% Off/Unknown year/t [x].mp4")


def test_fit_outtmpl_leaves_room_for_suffixes():
    info = {"id": "abcdefghijk", "title": "x:" * 200, "ext": "mp4", "uploader": "U"}
    tmpl = fit_outtmpl(
        lambda b: library_outtmpl(Path("/d"), "U", b), info, windowsfilenames=True
    )
    out = yt_dlp.YoutubeDL({"quiet": True, "windowsfilenames": True}).prepare_filename(
        info, outtmpl=tmpl
    )
    assert len(os.fsencode(os.path.basename(out))) <= 255 - NAME_SUFFIX_RESERVE


def test_windows_filenames_refused_for_roots_yt_dlp_would_rewrite():
    assert windows_filenames_ok(Path("/srv/horde/downloads"))
    assert not windows_filenames_ok(Path("/srv/nas:share/downloads"))
    assert not windows_filenames_ok(Path("/srv/horde./downloads"))
