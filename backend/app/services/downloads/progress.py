"""Live progress of a download: the snapshot store and the yt-dlp hooks feeding it."""

import logging
import threading
import time
from pathlib import Path
from typing import Any

from .. import activity
from ..mp4_compat import CompatPlan
from .artifacts import is_intermediate_media
from .errors import DownloadCancelled
from .infodict import as_info

logger = logging.getLogger(__name__)


_TERMINAL_PROGRESS = frozenset({"completed", "error", "cancelled", "skipped"})


PROGRESS_TTL_SECONDS = 600.0


class ProgressStore:
    """Live progress snapshots keyed by job id, consumed by the SSE endpoints.

    Dict-like, but thread-safe: ``merge`` is an atomic read-modify-write (workers,
    the metadata thread and ffmpeg callbacks all update the same job), and
    snapshots of finished jobs are pruned after a TTL so the map cannot grow
    without bound (the DB row is the source of truth afterwards).
    """

    def __init__(self, ttl: float = PROGRESS_TTL_SECONDS) -> None:
        self._lock = threading.RLock()
        self._data: dict[int, dict[str, Any]] = {}
        self._finished_at: dict[int, float] = {}
        self._ttl = ttl

    def __getitem__(self, job_id: int) -> dict[str, Any]:
        with self._lock:
            return self._data[job_id]

    def __setitem__(self, job_id: int, snapshot: dict[str, Any]) -> None:
        with self._lock:
            self._data[job_id] = snapshot
            if snapshot.get("status") in _TERMINAL_PROGRESS:
                self._finished_at[job_id] = time.monotonic()
            else:
                self._finished_at.pop(job_id, None)

    def __contains__(self, job_id: object) -> bool:
        with self._lock:
            return job_id in self._data

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def get(self, job_id: int, default: Any = None) -> Any:
        with self._lock:
            return self._data.get(job_id, default)

    def pop(self, job_id: int, *default: Any) -> Any:
        with self._lock:
            self._finished_at.pop(job_id, None)
            return self._data.pop(job_id, *default)

    def items(self) -> list[tuple[int, dict[str, Any]]]:
        with self._lock:
            return list(self._data.items())

    def clear(self) -> None:
        with self._lock:
            self._data.clear()
            self._finished_at.clear()

    def merge(self, job_id: int, fields: dict[str, Any]) -> dict[str, Any]:
        """Atomically overlay ``fields`` on the job's snapshot and return it."""
        with self._lock:
            snap = {**self._data.get(job_id, {}), **fields}
            self[job_id] = snap
            return snap

    def prune(self, now: float | None = None) -> int:
        """Drop snapshots of jobs that finished more than the TTL ago."""
        cutoff = (time.monotonic() if now is None else now) - self._ttl
        with self._lock:
            stale = [j for j, t in self._finished_at.items() if t <= cutoff]
            for job_id in stale:
                self._data.pop(job_id, None)
                self._finished_at.pop(job_id, None)
            return len(stale)


progress_store = ProgressStore()


# SSE `stage` tokens while status is `processing` (download card / watch indicator).
STAGE_MERGING = "merging"


STAGE_ENCODING_AUDIO = "encoding_audio"


STAGE_REMUXING = "remuxing"


STAGE_TRANSCODING = "transcoding"


STAGE_NORMALIZING = "normalizing"


_STAGE_ACTIVITY_DETAIL = {
    STAGE_MERGING: "Merging streams",
    STAGE_ENCODING_AUDIO: "Encoding audio to AAC",
    STAGE_REMUXING: "Remuxing MP4",
    STAGE_TRANSCODING: "Transcoding video",
    STAGE_NORMALIZING: "Normalizing volume",
}


_STREAM_SWITCH_SLOP = 512 * 1024


def _positive_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _progress_stream_total(d: dict[str, Any]) -> int | None:
    """Whole-file size for the current stream, not the current HTTP Range."""
    info = as_info(d.get("info_dict"))
    hint = _positive_int(info.get("filesize")) or _positive_int(
        info.get("filesize_approx")
    )
    hook = _positive_int(d.get("total_bytes")) or _positive_int(
        d.get("total_bytes_estimate")
    )
    if hint and hook:
        # YouTube HTTPS uses ~10MB Range chunks; hook total is often the chunk.
        return max(hint, hook)
    return hint or hook


def _progress_filename(d: dict[str, Any]) -> str:
    raw = d.get("filename") or ""
    try:
        return Path(str(raw)).name
    except (TypeError, ValueError):
        return str(raw)


class DownloadProgress:
    """Turn yt-dlp hook events into UI snapshots with consistent bytes/percent.

    Chunked HTTP and video-then-audio resets make hook `total_bytes` a poor
    denominator; this accumulates across streams and prefers format filesize.
    """

    def __init__(self) -> None:
        self.accumulated_bytes = 0
        self.last_stream_downloaded = 0
        self.accumulated_total = 0
        self.last_stream_total = 0
        self.max_displayed_bytes = 0

    def _note_stream_switch(self, downloaded: int) -> None:
        if downloaded < self.last_stream_downloaded - _STREAM_SWITCH_SLOP:
            self.accumulated_bytes += self.last_stream_downloaded
            self.accumulated_total += self.last_stream_total
            self.last_stream_downloaded = 0
            self.last_stream_total = 0

    def _apply_downloaded(self, downloaded: int, stream_total: int | None) -> None:
        self.last_stream_downloaded = max(self.last_stream_downloaded, downloaded)
        if stream_total:
            self.last_stream_total = max(self.last_stream_total, stream_total)
        combined = self.accumulated_bytes + self.last_stream_downloaded
        self.max_displayed_bytes = max(self.max_displayed_bytes, combined)

    def _combined_total(self) -> int | None:
        if self.last_stream_total:
            return self.accumulated_total + self.last_stream_total
        if self.accumulated_total:
            return self.accumulated_total + self.last_stream_downloaded
        return None

    def _ratio(self) -> float:
        total = self._combined_total()
        if not total:
            return 0.0
        return min(100.0, self.max_displayed_bytes / total * 100)

    def _downloading_snapshot(self, info: dict[str, Any]) -> dict[str, Any]:
        snap: dict[str, Any] = {
            "status": "downloading",
            "progress": round(self._ratio(), 1),
            "title": info.get("title"),
            "channel": info.get("uploader") or info.get("channel"),
            "downloaded_bytes": self.max_displayed_bytes,
        }
        total = self._combined_total()
        if total:
            snap["total_bytes"] = total
        return snap

    def _is_final_finished(self, d: dict[str, Any], downloaded: int) -> bool:
        name = _progress_filename(d)
        if name and is_intermediate_media(name):
            return False
        info = as_info(d.get("info_dict"))
        hint = _positive_int(info.get("filesize")) or _positive_int(
            info.get("filesize_approx")
        )
        if hint and downloaded and downloaded < int(hint * 0.95):
            return False
        return bool(name)

    def apply(self, d: dict[str, Any]) -> dict[str, Any] | None:
        status = d.get("status")
        info = as_info(d.get("info_dict"))
        if status == "downloading":
            downloaded = int(d.get("downloaded_bytes", 0) or 0)
            self._note_stream_switch(downloaded)
            self._apply_downloaded(downloaded, _progress_stream_total(d))
            return self._downloading_snapshot(info)
        if status == "finished":
            downloaded = (
                _positive_int(d.get("downloaded_bytes")) or self.last_stream_downloaded
            )
            if downloaded:
                self._note_stream_switch(downloaded)
                self._apply_downloaded(downloaded, _progress_stream_total(d))
            if not self._is_final_finished(d, downloaded or 0):
                return self._downloading_snapshot(info)
            snap: dict[str, Any] = {
                "status": "processing",
                "progress": min(100.0, max(self._ratio(), 99.0)),
                "downloaded_bytes": self.max_displayed_bytes,
            }
            total = self._combined_total()
            if total:
                snap["total_bytes"] = total
            title = info.get("title")
            if title:
                snap["title"] = title
            return snap
        return None


def processing_stage_for_compat(plan: CompatPlan) -> str | None:
    """Label the Safari MP4 pass: AAC encode when needed, otherwise remux."""
    if not plan.needed:
        return None
    if plan.transcode_audio:
        return STAGE_ENCODING_AUDIO
    return STAGE_REMUXING


def processing_stage_for_postprocessor(name: str | None) -> str | None:
    key = (name or "").lower().replace("ffmpeg", "")
    if "merger" in key:
        return STAGE_MERGING
    if "remux" in key:
        return STAGE_REMUXING
    return None


def publish_job_progress(job_id: int, fields: dict[str, Any]) -> dict[str, Any]:
    snap = progress_store.merge(job_id, fields)
    if snap.get("status") != "processing" and "stage" in snap:
        snap = {k: v for k, v in snap.items() if k != "stage"}
        progress_store[job_id] = snap
    return snap


def set_processing_stage(
    job_id: int, stage: str, progress: float | None = None
) -> dict[str, Any]:
    if progress is None:
        progress_n = 0.0
    else:
        try:
            progress_n = min(100.0, max(0.0, float(progress)))
        except (TypeError, ValueError):
            progress_n = 0.0
    return publish_job_progress(
        job_id,
        {
            "status": "processing",
            "stage": stage,
            "progress": progress_n,
        },
    )


def _processing_activity_detail(stage: str | None) -> str:
    if not stage:
        return "Processing"
    return _STAGE_ACTIVITY_DETAIL.get(str(stage), "Processing")


def make_progress_hook(
    job_id: int,
    cancel_event: threading.Event,
    activity_handle: activity.ActivityHandle | None = None,
):
    tracker = DownloadProgress()
    last_activity_at = 0.0
    last_activity_pct = -1.0

    def hook(d: dict[str, Any]) -> None:
        nonlocal last_activity_at, last_activity_pct
        if cancel_event.is_set():
            raise DownloadCancelled()
        if not isinstance(d, dict):
            return
        try:
            snap = tracker.apply(d)
            if not snap:
                return
            merged = publish_job_progress(job_id, snap)
            if activity_handle is None:
                return
            if merged.get("status") == "processing":
                activity_handle.update(
                    done=99,
                    total=100,
                    detail=_processing_activity_detail(merged.get("stage")),
                    engine="ffmpeg",
                )
                return
            now = time.time()
            pct_i = int(merged.get("progress") or 0)
            if now - last_activity_at >= 1.0 or pct_i >= last_activity_pct + 5:
                last_activity_at = now
                last_activity_pct = pct_i
                activity_handle.update(
                    done=pct_i,
                    total=100,
                    detail=merged.get("title") or None,
                )
        except DownloadCancelled:
            raise
        except Exception:
            logger.debug("download progress update failed", exc_info=True)
            return

    return hook


def make_postprocessor_hook(
    job_id: int,
    cancel_event: threading.Event,
    activity_handle: activity.ActivityHandle | None = None,
):
    def hook(d: dict[str, Any]) -> None:
        if cancel_event.is_set():
            raise DownloadCancelled()
        if not isinstance(d, dict):
            return
        if d.get("status") not in ("started", "processing"):
            return
        stage = processing_stage_for_postprocessor(d.get("postprocessor"))
        if not stage:
            return
        try:
            set_processing_stage(job_id, stage)
            if activity_handle is not None:
                activity_handle.update(
                    done=99,
                    total=100,
                    detail=_processing_activity_detail(stage),
                    engine="ffmpeg",
                )
        except DownloadCancelled:
            raise
        except Exception:
            logger.debug("download progress update failed", exc_info=True)
            return

    return hook
