"""Compatibility facade for the download pipeline, which now lives in ``services/downloads``.

New code should import from the package modules (``downloads.queue``,
``downloads.jobs``, ``downloads.progress``, ...). This module only re-exports the
names callers used to import from here, plus the yt-dlp helpers they reached
through it, and is kept for one release.
"""

from .downloads.errors import DownloadCancelled as DownloadCancelled
from .downloads.ffmpeg_queue import FfmpegQueue as FfmpegQueue
from .downloads.ffmpeg_queue import ffmpeg_queue as ffmpeg_queue
from .downloads.ffmpeg_queue import ffmpeg_slot_limit as ffmpeg_slot_limit
from .downloads.jobs import DUPLICATE_DOWNLOADING as DUPLICATE_DOWNLOADING
from .downloads.jobs import DUPLICATE_LIBRARY as DUPLICATE_LIBRARY
from .downloads.jobs import DUPLICATE_MESSAGES as DUPLICATE_MESSAGES
from .downloads.jobs import DUPLICATE_QUEUED as DUPLICATE_QUEUED
from .downloads.jobs import change_job_quality as change_job_quality
from .downloads.jobs import classify_enqueue_duplicate as classify_enqueue_duplicate
from .downloads.jobs import enqueue_download as enqueue_download
from .downloads.jobs import find_active_job as find_active_job
from .downloads.jobs import find_active_job_for_identity as find_active_job_for_identity
from .downloads.jobs import job_mutate_lock as job_mutate_lock
from .downloads.jobs import library_video_for_url as library_video_for_url
from .downloads.jobs import prepare_job_retry as prepare_job_retry
from .downloads.jobs import wait_until_job_not_running as wait_until_job_not_running
from .downloads.playlist_import import run_playlist_entries as run_playlist_entries
from .downloads.playlist_import import start_playlist_import as start_playlist_import
from .downloads.progress import PROGRESS_TTL_SECONDS as PROGRESS_TTL_SECONDS
from .downloads.progress import STAGE_ENCODING_AUDIO as STAGE_ENCODING_AUDIO
from .downloads.progress import STAGE_MERGING as STAGE_MERGING
from .downloads.progress import STAGE_NORMALIZING as STAGE_NORMALIZING
from .downloads.progress import STAGE_REMUXING as STAGE_REMUXING
from .downloads.progress import STAGE_TRANSCODING as STAGE_TRANSCODING
from .downloads.progress import ProgressStore as ProgressStore
from .downloads.progress import (
    processing_stage_for_compat as processing_stage_for_compat,
)
from .downloads.progress import (
    processing_stage_for_postprocessor as processing_stage_for_postprocessor,
)
from .downloads.progress import progress_store as progress_store
from .downloads.queue import REAPER_INTERVAL_SECONDS as REAPER_INTERVAL_SECONDS
from .downloads.queue import STUCK_JOB_GRACE_SECONDS as STUCK_JOB_GRACE_SECONDS
from .downloads.queue import DownloadQueue as DownloadQueue
from .downloads.queue import download_queue as download_queue
from .downloads.staging import DEVICE_STAGING_DIR as DEVICE_STAGING_DIR
from .downloads.staging import cleanup_device_job_files as cleanup_device_job_files
from .downloads.staging import device_job_dir as device_job_dir
from .downloads.staging import device_outtmpl as device_outtmpl
from .downloads.staging import gc_orphaned_device_dirs as gc_orphaned_device_dirs
from .downloads.staging import is_device_staging_path as is_device_staging_path
from .downloads.staging import remove_staging_dir as remove_staging_dir
from .downloads.subtitles import download_subtitles as download_subtitles
from .ytdlp_extract import estimate_playlist_sizes as estimate_playlist_sizes
from .ytdlp_extract import extract_playlist as extract_playlist
from .ytdlp_extract import extract_playlist_entries as extract_playlist_entries
from .ytdlp_extract import extract_preview as extract_preview
from .ytdlp_extract import fetch_channel_feed as fetch_channel_feed
from .ytdlp_extract import search_youtube_channels as search_youtube_channels
from .ytdlp_formats import QUALITY_FORMATS as QUALITY_FORMATS
