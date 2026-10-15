"""Exceptions, error predicates and the yt-dlp logger shared by the download stages."""

import logging

from ..url_clean import youtube_video_id
from ..ytdlp_common import is_members_only_message

logger = logging.getLogger(__name__)


class DownloadCancelled(Exception):
    """Raised from yt-dlp progress hooks when a job is cancelled or paused."""


def is_recoverable_download_error(exc: Exception) -> bool:
    msg = str(exc)
    return (
        "Unable to rename file" in msg
        or "Unable to download video subtitles" in msg
        or "Postprocessing:" in msg
        or "'NoneType' object has no attribute 'get'" in msg
    )


class YtdlpLogger:
    """Suppress noisy Windows file-lock rename errors from intermediate fragments."""

    def __init__(self) -> None:
        self.members_only = False
        self.last_members_only_msg: str | None = None

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        if "Unable to rename file" in msg:
            return
        if "Unable to download video subtitles" in msg:
            return
        if is_members_only_message(msg):
            self.members_only = True
            self.last_members_only_msg = msg
            return


def purge_members_only_yt_id(yt_id: str) -> None:
    try:
        from ..channel_catalog.skips import purge_members_only_by_yt_id

        purge_members_only_by_yt_id(yt_id)
    except Exception:
        logger.debug("members-only catalog purge failed", exc_info=True)


def purge_members_only_url(url: str) -> None:
    yt_id = youtube_video_id(url)
    if yt_id:
        purge_members_only_yt_id(yt_id)
