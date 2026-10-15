"""The ffmpeg-side steps after yt-dlp has produced a file, and the task that carries them."""

import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import activity, scanner
from ..ffmpeg_bin import ffmpeg_available, ffmpeg_bin
from ..ffmpeg_progress import FfmpegCancelled, run_ffmpeg
from ..fsutil import replace_with_retries, safe_rel, safe_unlink
from ..ytdlp_formats import effective_max_height


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
    job_id: int
    final_path: Path
    info: dict[str, Any]
    url: str
    quality_preset: str
    title_override: str | None
    channel_override: str | None
    normalize_volume: bool
    replace_video_id: int | None
    notes_pending: str | None
    cancel_event: threading.Event
    destination: str
    video_codec: str
    # Library downloads: per-job staging dir the media is promoted out of, and
    # the scanner marks to release once the postprocess stage is over.
    staging_dir: Path | None = None
    active_marks: set[str] = field(default_factory=set)
