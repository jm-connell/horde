"""Fetch one video's English captions for Ask, without the video.

A library copy with a caption file is read from disk (``from_library``). Otherwise
one subtitle-only yt-dlp call (``fetch_remote``) runs inside the extract gate
(``call_gated``, background priority), so it waits behind interactive and download
work and keeps the gate's spacing. The same call returns the description, so Ask
gets it for free.
"""

from __future__ import annotations

import logging
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlmodel import Session

from ...context import get_paths
from .. import library
from ..downloads.subtitles import SubtitleYtdlpLogger, subtitle_ydl_opts
from ..subtitle_retry import subtitle_failure_retryable
from ..ytdlp_common import (
    ERROR_KIND_BOT,
    ERROR_KIND_COOKIES,
    ERROR_KIND_MEMBERS,
    ERROR_KIND_POT,
    ERROR_KIND_RATE_LIMIT,
    ERROR_KIND_UNAVAILABLE,
    EXTRACT_PRIORITY_BACKGROUND,
    call_gated,
    classify_ytdlp_error,
    should_retry_with_cookies,
    url_cookie_required,
)

logger = logging.getLogger(__name__)

# Outcomes (``KbVideo.fetch_status`` except ``retry``).
FETCHED = "fetched"
NO_CAPTIONS = "no_captions"
MEMBERS_ONLY = "members_only"
FAILED = "failed"
RETRY = "retry"  # rate limited or bot check: try again later, everyone backs off

_RETRY_KINDS = frozenset({ERROR_KIND_RATE_LIMIT, ERROR_KIND_BOT, ERROR_KIND_POT})


@dataclass
class CaptionResult:
    status: str
    vtt: str = ""
    auto: bool | None = None
    description: str | None = None
    message: str | None = None


def video_url(yt_id: str) -> str:
    return f"https://www.youtube.com/watch?v={yt_id}"


def from_library(session: Session, yt_id: str) -> CaptionResult | None:
    """English captions of the library copy, or None when there is none on disk."""
    video = library.find_video_by_youtube_id(session, yt_id)
    if video is None:
        return None
    tracks = [
        t
        for t in library.parse_subtitles(video.subtitles)
        if str(t.get("lang") or "").lower().startswith("en") and t.get("path")
    ]
    tracks.sort(key=lambda t: 1 if t.get("auto") else 0)
    for track in tracks:
        path = get_paths().downloads / str(track["path"])
        try:
            vtt = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if vtt.strip():
            return CaptionResult(
                FETCHED,
                vtt=vtt,
                auto=bool(track.get("auto")),
                description=video.description,
            )
    return None


def _download(
    url: str, tmpdir: str, ytdlp_logger: SubtitleYtdlpLogger, *, with_cookies: bool
) -> dict[str, Any]:
    import yt_dlp

    opts = subtitle_ydl_opts(
        str(Path(tmpdir) / "captions.%(ext)s"),
        with_cookies=with_cookies,
        ytdlp_logger=ytdlp_logger,
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    return dict(info or {})


def _read_vtt(tmpdir: str) -> str:
    for entry in sorted(Path(tmpdir).iterdir()):
        if entry.is_file() and entry.suffix.lower() == ".vtt":
            return entry.read_text(encoding="utf-8", errors="ignore")
    return ""


def _fetch(url: str) -> CaptionResult:
    with tempfile.TemporaryDirectory() as tmpdir:
        ytdlp_logger = SubtitleYtdlpLogger()
        with_cookies = url_cookie_required(url)
        try:
            info = _download(url, tmpdir, ytdlp_logger, with_cookies=with_cookies)
        except Exception as exc:
            if with_cookies or not should_retry_with_cookies({}, exc):
                raise
            info = _download(url, tmpdir, ytdlp_logger, with_cookies=True)
        vtt = _read_vtt(tmpdir)
    description = info.get("description")
    if not vtt.strip():
        # A subtitle 429 is logged, not raised: the video itself loaded.
        logged = " ".join(ytdlp_logger.messages)
        if logged and subtitle_failure_retryable(logged):
            return CaptionResult(RETRY, description=description, message=logged[:300])
        return CaptionResult(NO_CAPTIONS, description=description)
    manual = info.get("subtitles") or {}
    auto = not any(str(lang).lower().startswith("en") for lang in manual)
    return CaptionResult(FETCHED, vtt=vtt, auto=auto, description=description)


def fetch_remote(yt_id: str) -> CaptionResult:
    """Captions from YouTube (the caller has reserved the timedtext pacer). Never raises."""
    url = video_url(yt_id)
    try:
        return call_gated(
            lambda: _fetch(url), url=url, priority=EXTRACT_PRIORITY_BACKGROUND
        )
    except Exception as exc:
        kind, message = classify_ytdlp_error(exc, url=url)
        logger.info("Ask: captions for %s failed (%s)", yt_id, kind, exc_info=True)
        if kind in (ERROR_KIND_MEMBERS, ERROR_KIND_COOKIES):
            return CaptionResult(MEMBERS_ONLY, message=message)
        if kind == ERROR_KIND_UNAVAILABLE:
            return CaptionResult(NO_CAPTIONS, message=message)
        if kind in _RETRY_KINDS:
            return CaptionResult(RETRY, message=message)
        return CaptionResult(FAILED, message=message)
