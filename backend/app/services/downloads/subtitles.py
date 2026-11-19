"""Best-effort subtitle fetch next to a finished download."""

import contextlib
import logging
import re
import shutil
from pathlib import Path
from typing import Any

from ..fsutil import safe_rel, safe_unlink
from ..paths import belongs_to_stem
from ..ytdlp_common import (
    apply_cookie_opts,
    should_retry_with_cookies,
    url_cookie_required,
    youtube_extractor_args,
)

logger = logging.getLogger(__name__)


class SubtitleYtdlpLogger:
    """Capture timedtext errors without printing them to stderr."""

    def __init__(self) -> None:
        self.messages: list[str] = []

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        if msg:
            self.messages.append(str(msg))

    def error(self, msg: str) -> None:
        if msg:
            self.messages.append(str(msg))


# Language token between the media stem and ``.vtt`` (``en``, ``en-US``, ``zh-Hans``).
SUBTITLE_LANG_RE = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*")


def normalize_lang(lang: str) -> str:
    return lang.split("-")[0].lower()


def collect_subtitles(final_path: Path) -> list[dict[str, Any]]:
    stem = final_path.stem
    parent = final_path.parent
    by_lang: dict[str, dict[str, Any]] = {}
    if not parent.is_dir():
        return []
    for entry in parent.iterdir():
        if not entry.is_file() or entry.suffix.lower() != ".vtt":
            continue
        if not belongs_to_stem(entry.name, stem):
            continue
        raw_lang = entry.name[len(stem) + 1 : -len(".vtt")]
        rel = safe_rel(entry)
        if not SUBTITLE_LANG_RE.fullmatch(raw_lang) or not rel:
            continue
        lang = normalize_lang(raw_lang)
        if lang not in by_lang or raw_lang.lower() == lang:
            by_lang[lang] = {"lang": lang, "path": rel, "auto": False}
    return list(by_lang.values())


def cleanup_subtitle_partials(parent: Path, stem: str) -> None:
    if not parent.is_dir():
        return
    for entry in parent.iterdir():
        if (
            entry.is_file()
            and belongs_to_stem(entry.name, stem)
            and entry.suffix.lower() == ".part"
        ):
            safe_unlink(entry)


def subtitle_ydl_opts(
    outtmpl: str,
    *,
    with_cookies: bool = False,
    ytdlp_logger: SubtitleYtdlpLogger | None = None,
) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en"],
        "subtitlesformat": "vtt/best",
        "outtmpl": outtmpl,
        "postprocessors": [{"key": "FFmpegSubtitlesConvertor", "format": "vtt"}],
        "extractor_args": youtube_extractor_args(),
        "logger": ytdlp_logger or SubtitleYtdlpLogger(),
    }
    return apply_cookie_opts(opts) if with_cookies else opts


def _is_translated(track: Any) -> bool:
    """A caption track YouTube machine-translates on request (``&tlang=``)."""
    return isinstance(track, dict) and "tlang=" in str(track.get("url") or "")


def drop_translated_captions(info: dict[str, Any]) -> None:
    """Keep a language's own automatic captions over machine translations of it.

    A video with dubbed audio tracks has speech-recognition captions for each
    dub, and YouTube offers every one of them translated into every language.
    yt-dlp takes the last track listed for a language, so "en" for an English
    video became its Spanish dub translated back to English: wrong words, and
    a request YouTube rate limits (429) almost at once.
    """
    captions = info.get("automatic_captions")
    if not isinstance(captions, dict):
        return
    for lang, tracks in captions.items():
        if not isinstance(tracks, list):
            continue
        own = [t for t in tracks if not _is_translated(t)]
        if own and len(own) != len(tracks):
            captions[lang] = own


def download_with_subtitles(ydl: Any, url: str) -> dict[str, Any]:
    """``ydl.extract_info(url, download=True)`` with ``drop_translated_captions``
    applied before yt-dlp picks the caption tracks to write."""
    info = ydl.extract_info(url, download=False, process=False)
    if not isinstance(info, dict):
        return {}
    drop_translated_captions(info)
    return dict(ydl.process_ie_result(info, download=True) or {})


def download_subtitles(media: Path, source_url: str):
    """Best-effort subtitle fetch; never raises. Uses a temp dir to avoid Windows locks.

    Returns a ``SubtitleFetchOutcome``: tracks when VTT landed, or ``retryable``
    when timedtext should be tried again later.
    """
    import tempfile

    import yt_dlp

    from ..subtitle_retry import SubtitleFetchOutcome, outcome_from_fetch

    if not media.exists():
        return SubtitleFetchOutcome(tracks=[], retryable=True)

    parent = media.parent
    stem = media.stem
    cleanup_subtitle_partials(parent, stem)
    ytdlp_logger = SubtitleYtdlpLogger()
    last_exc: BaseException | None = None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            outtmpl = str(Path(tmpdir) / f"{stem}.%(ext)s")
            with_cookies = url_cookie_required(source_url)
            try:
                with yt_dlp.YoutubeDL(
                    subtitle_ydl_opts(
                        outtmpl,
                        with_cookies=with_cookies,
                        ytdlp_logger=ytdlp_logger,
                    )
                ) as ydl:
                    download_with_subtitles(ydl, source_url)
            except Exception as exc:
                if with_cookies or not should_retry_with_cookies({}, exc):
                    raise
                with yt_dlp.YoutubeDL(
                    subtitle_ydl_opts(
                        outtmpl,
                        with_cookies=True,
                        ytdlp_logger=ytdlp_logger,
                    )
                ) as ydl:
                    download_with_subtitles(ydl, source_url)

            for entry in Path(tmpdir).iterdir():
                if not entry.is_file() or entry.suffix.lower() != ".vtt":
                    continue
                dest = parent / entry.name
                try:
                    shutil.copy2(entry, dest)
                except OSError:
                    safe_unlink(dest)
                    with contextlib.suppress(OSError):
                        shutil.copy2(entry, dest)
    except Exception as exc:
        logger.debug("subtitle fetch attempt failed", exc_info=True)
        last_exc = exc

    return outcome_from_fetch(
        collect_subtitles(media),
        messages=ytdlp_logger.messages,
        exc=last_exc,
    )
