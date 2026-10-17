"""Derive the YouTube video id a library row stands for."""

from __future__ import annotations

import re

from .url_clean import youtube_video_id

# yt-dlp's default output template appends ``[<11-char id>]`` to the file name.
_PATH_ID_RE = re.compile(r"\[([A-Za-z0-9_-]{11})\]")


def derive_youtube_id(source_url: str | None, file_path: str | None) -> str | None:
    """The id from ``source_url``, else from a ``[id]`` token in ``file_path``."""
    if source_url:
        found = youtube_video_id(source_url)
        if found:
            return found
    if file_path:
        match = _PATH_ID_RE.search(file_path)
        if match:
            return match.group(1)
    return None
