"""The periodic metadata sync logs an offline source as one line, not a traceback."""

from __future__ import annotations

import logging
import sys

import pytest
from yt_dlp.networking.exceptions import ProxyError
from yt_dlp.utils import DownloadError, ExtractorError

from app.services import metadata_sync


class _OnePass:
    """Just enough of a BackgroundWorker for one pass of the loop."""

    stopping = False

    def sleep(self, _seconds: float) -> bool:
        return True


def _network_error() -> DownloadError:
    """What yt-dlp raises when the proxy or the network is down."""
    try:
        try:
            raise ProxyError("Unable to connect to proxy")
        except ProxyError as exc:
            raise ExtractorError("Unable to download API page", cause=exc) from exc
    except ExtractorError as exc:
        return DownloadError(f"ERROR: {exc}", sys.exc_info())


def _run_once(monkeypatch, error: Exception) -> None:
    def fail(url: str):
        raise error

    monkeypatch.setattr(metadata_sync, "_extract_metadata", fail)
    monkeypatch.setattr(
        "app.services.channel_catalog.refresh_stale_catalogs", lambda: None
    )
    monkeypatch.setattr(
        "app.services.playlist_sync.sync_subscribed_playlists", lambda: None
    )
    metadata_sync.run_periodic_sync(_OnePass())  # type: ignore[arg-type]  # test double


def _records(caplog, level: int) -> list[logging.LogRecord]:
    return [
        r
        for r in caplog.records
        if r.name == metadata_sync.logger.name and r.levelno == level
    ]


def test_unreachable_source_is_one_warning_line(add_video, monkeypatch, caplog):
    video = add_video(source_url="https://www.youtube.com/watch?v=ABCDEFGHIJ1")
    with caplog.at_level(logging.DEBUG, logger=metadata_sync.logger.name):
        _run_once(monkeypatch, _network_error())

    warnings = _records(caplog, logging.WARNING)
    assert len(warnings) == 1
    assert warnings[0].exc_info is None
    assert str(video.id) in warnings[0].getMessage()
    assert "unreachable" in warnings[0].getMessage()
    # The traceback is still there for whoever turns on debug logging.
    assert any(r.exc_info for r in _records(caplog, logging.DEBUG))


@pytest.mark.parametrize("error", [ValueError("bug"), DownloadError("ERROR: HTTP 404")])
def test_other_failures_keep_their_traceback(add_video, monkeypatch, caplog, error):
    add_video(source_url="https://www.youtube.com/watch?v=ABCDEFGHIJ1")
    with caplog.at_level(logging.DEBUG, logger=metadata_sync.logger.name):
        _run_once(monkeypatch, error)

    warnings = _records(caplog, logging.WARNING)
    assert len(warnings) == 1
    assert warnings[0].exc_info is not None
