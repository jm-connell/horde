"""Pending subtitle retries after timedtext 429s."""

from datetime import datetime, timedelta, timezone

import pytest

from app.services.subtitle_retry import (
    BACKOFF_SECONDS,
    SubtitleFetchOutcome,
    apply_subtitle_outcome,
    backoff_seconds,
    captions_fetch_allowed,
    next_due_video,
    outcome_from_fetch,
    process_due_subtitle,
    recover_unsynced_missing_captions,
    reset_for_tests,
    subtitle_failure_retryable,
)
from app.services.ytdlp_common import ERROR_KIND_RATE_LIMIT


@pytest.fixture(autouse=True)
def _reset_subtitle_retry_state():
    reset_for_tests()
    yield
    reset_for_tests()


_SUBTITLE_429 = (
    "ERROR: Unable to download video subtitles for 'en': "
    "HTTP Error 429: Too Many Requests"
)


def test_subtitle_429_is_retryable():
    assert subtitle_failure_retryable(_SUBTITLE_429)
    outcome = outcome_from_fetch([], messages=[_SUBTITLE_429])
    assert outcome.retryable
    assert outcome.kind == ERROR_KIND_RATE_LIMIT
    assert not outcome.tracks


def test_no_subtitles_is_not_retryable():
    assert not subtitle_failure_retryable(
        "There's no subtitles for the requested languages"
    )
    assert not subtitle_failure_retryable(
        "Unable to download video subtitles for 'en': HTTP Error 404: Not Found"
    )
    empty = outcome_from_fetch([])
    assert not empty.retryable
    assert empty.tracks == []


def test_backoff_caps_at_one_hour():
    assert backoff_seconds(1) == BACKOFF_SECONDS[0]
    assert backoff_seconds(2) > backoff_seconds(1)
    assert backoff_seconds(99) == BACKOFF_SECONDS[-1] == 3600


def test_apply_keeps_pending_after_429(add_video, session):
    video = add_video(source_url="https://youtu.be/aaaaaaaaaaa")
    apply_subtitle_outcome(
        video.id,
        SubtitleFetchOutcome(
            tracks=[],
            retryable=True,
            kind=ERROR_KIND_RATE_LIMIT,
            message=_SUBTITLE_429,
        ),
    )
    session.refresh(video)
    assert video.subtitles_pending is True
    assert video.subtitles_fetch_attempts == 1
    from app.models import as_utc

    retry = as_utc(video.subtitles_retry_after)
    assert retry is not None
    assert (retry - datetime.now(timezone.utc)).total_seconds() > 240


def test_apply_clears_pending_when_tracks_arrive(add_video, session):
    video = add_video(
        source_url="https://youtu.be/aaaaaaaaaaa",
        subtitles_pending=True,
        subtitles_fetch_attempts=2,
    )
    apply_subtitle_outcome(
        video.id,
        SubtitleFetchOutcome(
            tracks=[{"lang": "en", "path": "a.en.vtt", "auto": False}],
            retryable=False,
        ),
    )
    session.refresh(video)
    assert video.subtitles_pending is False
    assert video.subtitles_retry_after is None
    assert video.subtitles_fetch_attempts == 0
    assert "en" in video.subtitles


def test_apply_gives_up_when_source_has_no_captions(add_video, session):
    video = add_video(
        source_url="https://youtu.be/aaaaaaaaaaa",
        subtitles_pending=True,
    )
    apply_subtitle_outcome(
        video.id,
        SubtitleFetchOutcome(tracks=[], retryable=False),
    )
    session.refresh(video)
    assert video.subtitles_pending is False
    assert video.subtitles_retry_after is None


def test_recover_marks_unsynced_empty_captions(add_video, session):
    forgotten = add_video(source_url="https://youtu.be/forgotten1")
    already_synced = add_video(
        source_url="https://youtu.be/synced1",
        metadata_synced_at=datetime.now(timezone.utc),
    )
    has_captions = add_video(
        source_url="https://youtu.be/hascaps",
        subtitles='[{"lang":"en","path":"x.en.vtt","auto":false}]',
    )
    too_old = add_video(
        source_url="https://youtu.be/oldone",
        added_at=datetime.now(timezone.utc) - timedelta(days=14),
    )
    assert recover_unsynced_missing_captions() >= 1
    session.refresh(forgotten)
    session.refresh(already_synced)
    session.refresh(has_captions)
    session.refresh(too_old)
    assert forgotten.subtitles_pending is True
    assert already_synced.subtitles_pending is False
    assert has_captions.subtitles_pending is False
    assert too_old.subtitles_pending is False


def test_next_due_skips_backoff_and_prefers_recent(add_video, session):
    now = datetime.now(timezone.utc)
    waiting = add_video(
        source_url="https://youtu.be/wait",
        subtitles_pending=True,
        subtitles_retry_after=now + timedelta(hours=1),
        added_at=now - timedelta(minutes=1),
    )
    older = add_video(
        source_url="https://youtu.be/older",
        subtitles_pending=True,
        added_at=now - timedelta(hours=3),
    )
    newer = add_video(
        source_url="https://youtu.be/newer",
        subtitles_pending=True,
        added_at=now - timedelta(minutes=5),
    )
    picked = next_due_video(session)
    assert picked is not None
    assert picked.id == newer.id
    assert picked.id != waiting.id
    assert picked.id != older.id


def test_process_due_fetches_and_applies(add_video, session, monkeypatch):
    video = add_video(
        source_url="https://youtu.be/aaaaaaaaaaa",
        subtitles_pending=True,
        write_file=True,
    )
    monkeypatch.setattr(
        "app.services.downloader.download_subtitles",
        lambda media, url: SubtitleFetchOutcome(
            tracks=[{"lang": "en", "path": "a.en.vtt", "auto": False}],
        ),
    )
    assert process_due_subtitle() is True
    session.refresh(video)
    assert video.subtitles_pending is False
    assert "en" in video.subtitles


def test_captions_fetch_blocked_during_backoff(add_video):
    video = add_video(
        source_url="https://youtu.be/aaaaaaaaaaa",
        subtitles_pending=True,
        subtitles_retry_after=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    assert captions_fetch_allowed(video) is False


def test_metadata_sync_skips_captions_during_backoff(add_video, monkeypatch):
    video = add_video(
        source_url="https://youtu.be/aaaaaaaaaaa",
        subtitles_pending=True,
        subtitles_retry_after=datetime.now(timezone.utc) + timedelta(hours=1),
        write_file=True,
    )
    monkeypatch.setattr(
        "app.services.metadata_sync._extract_metadata",
        lambda url: {"title": "T", "description": "D", "view_count": 3},
    )
    called = {"n": 0}

    def boom(*_args, **_kwargs):
        called["n"] += 1
        raise AssertionError("timedtext fetch should wait out backoff")

    monkeypatch.setattr("app.services.downloader.download_subtitles", boom)
    from app.services.metadata_sync import refresh_video_metadata

    refresh_video_metadata(video.id, fields=["captions"])
    assert called["n"] == 0
