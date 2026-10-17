"""``services.downloader`` keeps re-exporting the names that moved to ``services/downloads``."""

from __future__ import annotations

import pytest

from app.services import downloader, ytdlp_extract, ytdlp_formats
from app.services.downloads import (
    errors,
    ffmpeg_queue,
    jobs,
    playlist_import,
    progress,
    queue,
    staging,
    subtitles,
)

MOVED = [
    (errors, "DownloadCancelled"),
    (ffmpeg_queue, "FfmpegQueue"),
    (ffmpeg_queue, "ffmpeg_queue"),
    (ffmpeg_queue, "ffmpeg_slot_limit"),
    (jobs, "DUPLICATE_DOWNLOADING"),
    (jobs, "DUPLICATE_LIBRARY"),
    (jobs, "DUPLICATE_MESSAGES"),
    (jobs, "DUPLICATE_QUEUED"),
    (jobs, "change_job_quality"),
    (jobs, "classify_enqueue_duplicate"),
    (jobs, "enqueue_download"),
    (jobs, "find_active_job"),
    (jobs, "find_active_job_for_identity"),
    (jobs, "job_mutate_lock"),
    (jobs, "library_video_for_url"),
    (jobs, "prepare_job_retry"),
    (jobs, "wait_until_job_not_running"),
    (playlist_import, "run_playlist_entries"),
    (playlist_import, "start_playlist_import"),
    (progress, "PROGRESS_TTL_SECONDS"),
    (progress, "ProgressStore"),
    (progress, "STAGE_ENCODING_AUDIO"),
    (progress, "STAGE_MERGING"),
    (progress, "STAGE_NORMALIZING"),
    (progress, "STAGE_REMUXING"),
    (progress, "STAGE_TRANSCODING"),
    (progress, "processing_stage_for_compat"),
    (progress, "processing_stage_for_postprocessor"),
    (progress, "progress_store"),
    (queue, "DownloadQueue"),
    (queue, "REAPER_INTERVAL_SECONDS"),
    (queue, "STUCK_JOB_GRACE_SECONDS"),
    (queue, "download_queue"),
    (staging, "DEVICE_STAGING_DIR"),
    (staging, "cleanup_device_job_files"),
    (staging, "device_job_dir"),
    (staging, "device_outtmpl"),
    (staging, "gc_orphaned_device_dirs"),
    (staging, "is_device_staging_path"),
    (staging, "remove_staging_dir"),
    (subtitles, "download_subtitles"),
    (ytdlp_extract, "estimate_playlist_sizes"),
    (ytdlp_extract, "extract_playlist"),
    (ytdlp_extract, "extract_playlist_entries"),
    (ytdlp_extract, "extract_preview"),
    (ytdlp_extract, "fetch_channel_feed"),
    (ytdlp_extract, "search_youtube_channels"),
    (ytdlp_formats, "QUALITY_FORMATS"),
]


@pytest.mark.parametrize(("module", "name"), MOVED)
def test_facade_exports_the_same_object(module, name):
    assert getattr(downloader, name) is getattr(module, name)
