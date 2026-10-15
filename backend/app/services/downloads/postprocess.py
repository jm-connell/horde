"""The ffmpeg-side steps after yt-dlp has produced a file, and the task that carries them."""

import subprocess
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import activity, scanner
from ..ffmpeg_bin import ffmpeg_available, ffmpeg_bin
from ..ffmpeg_progress import FfmpegCancelled, run_ffmpeg
from ..fsutil import replace_with_retries, safe_rel, safe_unlink
from ..metadata import probe_dimensions, probe_duration
from ..mp4_compat import compat_plan, ensure_safari_mp4, probe_media
from ..video_transcode import encode_target, transcode_video
from ..ytdlp_formats import effective_max_height, is_audio_preset
from .errors import DownloadCancelled
from .progress import (
    STAGE_NORMALIZING,
    STAGE_TRANSCODING,
    processing_stage_for_compat,
    progress_store,
    set_processing_stage,
)
from .spec import JobSpec


def check_quality(
    preset: str, height: int | None, video_codec: str = "av1"
) -> str | None:
    """Return a warning string if actual height is below the requested cap tier."""
    # H.264-native mode caps 1440p/4K presets at 1080p by design — not a warning.
    max_h = effective_max_height(preset, video_codec)
    if max_h is None or height is None:
        return None
    # Allow a few pixels of encoder/probe variance (e.g. 1078 vs 1080).
    if height + 8 < max_h:
        return (
            f"Requested {preset} but file is {height}p — "
            "source may not offer that quality."
        )
    return None


def apply_loudnorm(
    path: Path,
    *,
    cancel_event: threading.Event | None = None,
    on_progress: Any | None = None,
    duration: float | None = None,
) -> str | None:
    """Normalize loudness via ffmpeg; returns warning if skipped."""
    if not ffmpeg_available():
        return "Volume normalization skipped: ffmpeg not found"
    # Unique sidecar so concurrent workers / scanner never share one .norm.mp4.
    tmp = path.with_name(f"{path.stem}.norm.{threading.get_ident()}.mp4")
    tmp_rel = safe_rel(tmp)
    if tmp_rel:
        scanner.mark_active(tmp_rel)
    cmd = [
        ffmpeg_bin(),
        "-y",
        "-i",
        str(path),
        "-af",
        "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        str(tmp),
    ]
    try:
        with activity.track(
            "loudnorm",
            "Normalizing volume",
            reason="Volume normalization enabled for this download",
            engine="ffmpeg",
            detail=path.name,
        ):
            run_ffmpeg(
                cmd,
                duration=duration,
                on_progress=on_progress,
                cancel_event=cancel_event,
                timeout=3600,
            )
            replace_with_retries(tmp, path)
        return None
    except FfmpegCancelled:
        safe_unlink(tmp)
        raise
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        safe_unlink(tmp)
        return "Volume normalization failed"
    finally:
        if tmp_rel:
            scanner.unmark_active(tmp_rel)
        if tmp.exists():
            safe_unlink(tmp)


@dataclass
class PostprocessTask:
    """A finished yt-dlp download waiting for its remux/transcode/commit stage."""

    spec: JobSpec
    final_path: Path
    info: dict[str, Any]
    cancel_event: threading.Event
    # Library downloads: per-job staging dir the media is promoted out of, and
    # the scanner marks to release once the postprocess stage is over.
    staging_dir: Path | None = None
    active_marks: set[str] = field(default_factory=set)

    @property
    def job_id(self) -> int:
        return self.spec.job_id

    @property
    def destination(self) -> str:
        return self.spec.destination


@dataclass(frozen=True)
class ProcessedMedia:
    final_path: Path
    #: Set when volume normalization was asked for but skipped or failed.
    volume_warning: str | None = None


def _duration_hint(path: Path, info: dict[str, Any]) -> float | None:
    duration = probe_duration(path) or info.get("duration")
    try:
        return float(duration) if duration else None
    except (TypeError, ValueError):
        return None


def _progress_reporter(job_id: int) -> Callable[[float], None]:
    def report(pct: float) -> None:
        prev = progress_store.get(job_id, {})
        stage = str(prev.get("stage") or STAGE_TRANSCODING)
        set_processing_stage(job_id, stage, progress=pct)

    return report


def _remux_for_safari(
    task: PostprocessTask, path: Path, duration: float | None
) -> Path:
    """Remux/re-encode audio so the MP4 plays in Safari (a no-op when it already does)."""
    if not path.exists():
        return path
    probe = probe_media(path)
    if probe is not None:
        stage = processing_stage_for_compat(compat_plan(probe))
        if stage:
            set_processing_stage(task.job_id, stage, progress=0.0)
    return ensure_safari_mp4(
        path,
        cancel_event=task.cancel_event,
        on_progress=_progress_reporter(task.job_id),
        duration=duration,
    )


def _transcode_to_target(
    task: PostprocessTask, path: Path, info: dict[str, Any], duration: float | None
) -> Path:
    """Re-encode to the H.264 target of the job's compatibility mode, if it needs one."""
    spec = task.spec
    if spec.codec == "av1" or not path.exists() or is_audio_preset(spec.quality_preset):
        return path
    probe = probe_media(path)
    dims = probe_dimensions(path)
    height_now = dims[1] if dims else None
    if height_now is None:
        raw_h = info.get("height")
        height_now = int(raw_h) if raw_h else None
    target = encode_target(
        spec.codec,
        probe.video_codec if probe else None,
        height_now,
        preset=spec.quality_preset,
    )
    if not target:
        return path
    set_processing_stage(task.job_id, STAGE_TRANSCODING, progress=0.0)
    return transcode_video(
        path,
        target,
        cancel_event=task.cancel_event,
        on_progress=_progress_reporter(task.job_id),
        duration=duration,
    )


def process_media(task: PostprocessTask, info: dict[str, Any]) -> ProcessedMedia:
    """Run the ffmpeg steps a download needs: Safari remux, transcode, loudness."""
    duration = _duration_hint(task.final_path, info)
    try:
        path = _remux_for_safari(task, task.final_path, duration)
        path = _transcode_to_target(task, path, info, duration)
        volume_warning: str | None = None
        if task.spec.normalize_volume and path.exists():
            set_processing_stage(task.job_id, STAGE_NORMALIZING, progress=0.0)
            volume_warning = apply_loudnorm(
                path,
                cancel_event=task.cancel_event,
                on_progress=_progress_reporter(task.job_id),
                duration=duration,
            )
    except FfmpegCancelled as exc:
        raise DownloadCancelled() from exc
    return ProcessedMedia(path, volume_warning)
