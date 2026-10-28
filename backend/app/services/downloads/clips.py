"""Clips: one part of a video (usually a live stream), saved as its own video.

A clip job carries ``clip_start_sec`` / ``clip_end_sec``, measured from the start
of the broadcast. The runner fetches only that part: with yt-dlp's
``download_ranges`` once the stream has ended, or by reading the broadcast's own
HLS segments while it is still live (YouTube keeps them addressable by number
for hours, the same DVR window the live player scrubs through).

A clip is a library video of its own, not a copy of the full video: its info is
rewritten so it carries no YouTube id (the file name's ``[...]`` token is not an
11-character id, and the row gets no ``source_url``). Nothing that matches
videos by YouTube id (duplicate checks, replace-in-place, SponsorBlock, stream
AI carry-over, metadata sync) mistakes it for the full stream, and several clips
of one stream can sit side by side.
"""

from __future__ import annotations

import logging
import math
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..ffmpeg_bin import ffmpeg_bin
from ..live import hls
from ..live.sessions import clip_source
from ..url_safety import UrlFetchError, fetch_bytes
from .errors import DownloadCancelled

logger = logging.getLogger(__name__)

#: Longest clip a request may ask for.
MAX_CLIP_SEC = 6 * 3600.0
_MAX_PLAYLIST_BYTES = 4 * 1024 * 1024
_MAX_SEGMENT_BYTES = 64 * 1024 * 1024
_FFMPEG_TIMEOUT_SEC = 30 * 60
_SEGMENT_ATTEMPTS = 3


class ClipUnavailable(RuntimeError):
    """That part of the broadcast cannot be read (any more)."""


def clock_label(sec: float) -> str:
    """``1:02:03`` / ``4:05``: a position the way the player shows it."""
    total = max(0, int(sec))
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def clip_suffix(start: float, end: float) -> str:
    return f"(clip {clock_label(start)}–{clock_label(end)})"


def _id_num(sec: float) -> str:
    """``12``, ``12.5``: clips under a second apart still get their own file."""
    return f"{sec:.3f}".rstrip("0").rstrip(".")


def clip_info(info: dict[str, Any], start: float, end: float) -> dict[str, Any]:
    """``info`` rewritten to describe the clip instead of the whole video."""
    out = dict(info)
    original_id = str(info.get("id") or "video")
    source = info.get("webpage_url") or info.get("original_url")
    suffix = clip_suffix(start, end)
    title = str(info.get("title") or "").strip()
    if not title.endswith(suffix):
        title = f"{title} {suffix}".strip()
    out["title"] = title
    out["fulltitle"] = title
    # Not an 11-character YouTube id, so neither the file name nor the row
    # derives one (services/youtube_id.py).
    out["id"] = f"{original_id}-clip-{_id_num(start)}-{_id_num(end)}"
    out["duration"] = max(0.0, end - start)
    for key in (
        "webpage_url",
        "original_url",
        "chapters",
        "subtitles",
        "automatic_captions",
        "is_live",
        "was_live",
        "live_status",
    ):
        out.pop(key, None)
    line = f"Clip {clock_label(start)}–{clock_label(end)}"
    if source:
        line += f" of {source}"
    description = str(info.get("description") or "").strip()
    out["description"] = f"{line}\n\n{description}" if description else line
    return out


def literal_outtmpl(ydl: Any, outtmpl: str, info: dict[str, Any]) -> str:
    """``outtmpl`` rendered for ``info`` with only the extension left to fill.

    yt-dlp fills the template from the info it extracts itself (the real id and
    title), so a clip's name is rendered here, from the clip's info, first.
    """
    rendered = str(ydl.prepare_filename({**info, "ext": "mp4"}, outtmpl=outtmpl))
    stem = rendered[: -len(".mp4")] if rendered.endswith(".mp4") else rendered
    return stem.replace("%", "%%") + ".%(ext)s"


def download_range_opts(start: float, end: float) -> dict[str, Any]:
    from yt_dlp.utils import download_range_func

    return {
        "download_ranges": download_range_func(None, [(start, end)]),
        # Cut on the nearest keyframes: no re-encode, a second or two of slack.
        "force_keyframes_at_cuts": False,
    }


def _fetch(url: str, headers: dict[str, str], max_bytes: int) -> bytes:
    return fetch_bytes(url, max_bytes=max_bytes, headers=headers).body


def _segment_range(
    url: str, headers: dict[str, str], start: float, end: float
) -> tuple[str, int, int, float]:
    """(segment URL template, first sq, last sq, target duration) for the clip."""
    try:
        body = _fetch(url, headers, _MAX_PLAYLIST_BYTES)
    except UrlFetchError as exc:
        raise ClipUnavailable(f"Could not read the live stream: {exc}") from exc
    playlist = hls.parse_media_playlist(body.decode("utf-8", errors="replace"), url)
    head = playlist.head_sq
    target = playlist.target_duration
    template = (
        hls.segment_template(playlist.segments[-1].uri) if playlist.segments else None
    )
    if head is None or not target or template is None:
        raise ClipUnavailable("The live stream does not list its segments")
    first = int(start // target)
    last = min(head, max(first, math.ceil(end / target) - 1))
    if first > head:
        raise ClipUnavailable("That part of the stream has not been broadcast yet")
    return template, first, last, target


def _fetch_segment(
    template: str,
    headers: dict[str, str],
    sq: int,
    *,
    first: bool,
    cancel: threading.Event,
) -> bytes:
    """One segment, retried a couple of times (a CDN edge can blip mid-clip)."""
    for attempt in range(_SEGMENT_ATTEMPTS):
        try:
            return _fetch(hls.fill_template(template, sq), headers, _MAX_SEGMENT_BYTES)
        except UrlFetchError as exc:
            if attempt == _SEGMENT_ATTEMPTS - 1:
                if first:
                    raise ClipUnavailable(
                        "That part of the stream is no longer available"
                    ) from exc
                raise
            logger.debug("live clip segment %s failed; retrying", sq, exc_info=True)
            if cancel.wait(attempt + 1):
                raise DownloadCancelled() from exc
    raise AssertionError("unreachable")


def _fetch_segments(
    template: str,
    headers: dict[str, str],
    first: int,
    last: int,
    dest: Path,
    *,
    cancel: threading.Event,
    on_progress: Callable[[float], None],
    share: tuple[float, float],
) -> None:
    """Append segments ``first..last`` to ``dest`` (TS and packed AAC concatenate)."""
    count = last - first + 1
    lo, span = share
    with dest.open("wb") as out:
        for i, sq in enumerate(range(first, last + 1)):
            if cancel.is_set():
                raise DownloadCancelled()
            out.write(
                _fetch_segment(template, headers, sq, first=i == 0, cancel=cancel)
            )
            on_progress(lo + span * (i + 1) / count)


def download_live_clip(
    info: dict[str, Any],
    start: float,
    end: float,
    dest: Path,
    *,
    cancel: threading.Event,
    on_progress: Callable[[float], None],
) -> Path:
    """Cut ``start..end`` (seconds from the broadcast start) of a live stream to ``dest``.

    Raises ClipUnavailable, DownloadCancelled or RuntimeError (ffmpeg failed).
    """
    source = clip_source(info)
    template, first, last, target = _segment_range(
        source.video_url, source.video_headers, start, end
    )
    work = dest.parent
    work.mkdir(parents=True, exist_ok=True)
    video_ts = work / ".clip-video.ts"
    audio_aac = work / ".clip-audio.aac"
    has_audio = source.audio_url is not None
    video_share = (0.0, 90.0 if not has_audio else 60.0)
    _fetch_segments(
        template,
        source.video_headers,
        first,
        last,
        video_ts,
        cancel=cancel,
        on_progress=on_progress,
        share=video_share,
    )
    if source.audio_url is not None:
        audio_template, _a_first, audio_last, _t = _segment_range(
            source.audio_url, source.audio_headers, start, end
        )
        _fetch_segments(
            audio_template,
            source.audio_headers,
            first,
            # The audio playlist can be a segment behind the video near live.
            min(last, audio_last),
            audio_aac,
            cancel=cancel,
            on_progress=on_progress,
            share=(60.0, 30.0),
        )
    # Seek on the inputs: with stream copy the cut then starts on a keyframe
    # instead of on frames that cannot be decoded.
    seek = ["-ss", f"{max(0.0, start - first * target):.3f}"]
    cmd = [ffmpeg_bin(), "-y", "-v", "error", *seek, "-i", str(video_ts)]
    if has_audio:
        cmd += [*seek, "-i", str(audio_aac), "-map", "0:v:0", "-map", "1:a:0"]
    cmd += [
        "-t",
        f"{max(0.1, end - start):.3f}",
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-movflags",
        "+faststart",
        str(dest),
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=_FFMPEG_TIMEOUT_SEC
        )
    except (subprocess.SubprocessError, OSError) as exc:
        raise RuntimeError(f"Could not cut the clip: {exc}") from exc
    finally:
        for part in (video_ts, audio_aac):
            part.unlink(missing_ok=True)
    if result.returncode != 0 or not dest.exists() or dest.stat().st_size <= 0:
        logger.warning("ffmpeg could not cut a live clip: %s", result.stderr[-2000:])
        raise RuntimeError("Could not cut the clip from the live stream")
    on_progress(100.0)
    return dest
