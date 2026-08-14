"""In-process registry of live and recently finished background tasks.

Used by Settings → System → Background activity so users can see what is
burning CPU (ffmpeg, yt-dlp, Ollama, etc.) and why each job started.
"""

from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from typing import Any, Generator, Iterator, Optional

# kind -> group for UI badges / queued chips
KIND_GROUPS: dict[str, str] = {
    "sprites": "media",
    "thumbnail": "media",
    "loudnorm": "media",
    "download": "download",
    "finalize": "download",
    "playlist_import": "download",
    "scan": "library",
    "ai": "ai",
    "model_pull": "ai",
    "catalog": "index",
    "metadata_sync": "library",
    "feed_enrich": "index",
}

_RECENT_MAX = 40


@dataclass
class ActivityTask:
    id: str
    kind: str
    group: str
    label: str
    reason: Optional[str] = None
    engine: Optional[str] = None
    detail: Optional[str] = None
    video_id: Optional[int] = None
    done: Optional[int] = None
    total: Optional[int] = None
    status: str = "running"  # running | completed | failed | cancelled
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ActivityHandle:
    """Mutable handle returned by track()/start() for progress updates."""

    def __init__(self, task_id: str) -> None:
        self.id = task_id
        self._closed = False

    def update(
        self,
        *,
        done: Optional[int] = None,
        total: Optional[int] = None,
        detail: Optional[str] = None,
        label: Optional[str] = None,
        engine: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> None:
        update(self.id, done=done, total=total, detail=detail, label=label, engine=engine, reason=reason)

    def finish(
        self,
        status: str = "completed",
        *,
        error: Optional[str] = None,
        detail: Optional[str] = None,
    ) -> None:
        if self._closed:
            return
        self._closed = True
        finish(self.id, status=status, error=error, detail=detail)

    def discard(self) -> None:
        if self._closed:
            return
        self._closed = True
        discard(self.id)


_lock = threading.Lock()
_running: dict[str, ActivityTask] = {}
_recent: deque[ActivityTask] = deque(maxlen=_RECENT_MAX)
# Kind -> count of tasks waiting on a concurrency gate (e.g. sprite semaphore).
_queued_extra: dict[str, int] = {}


def start(
    kind: str,
    label: str,
    *,
    reason: Optional[str] = None,
    engine: Optional[str] = None,
    detail: Optional[str] = None,
    video_id: Optional[int] = None,
    total: Optional[int] = None,
    done: Optional[int] = None,
    group: Optional[str] = None,
) -> ActivityHandle:
    task_id = uuid.uuid4().hex
    task = ActivityTask(
        id=task_id,
        kind=kind,
        group=group or KIND_GROUPS.get(kind, "library"),
        label=label,
        reason=reason,
        engine=engine,
        detail=detail,
        video_id=video_id,
        done=done,
        total=total,
        status="running",
        started_at=time.time(),
    )
    with _lock:
        _running[task_id] = task
    return ActivityHandle(task_id)


def update(
    task_id: str,
    *,
    done: Optional[int] = None,
    total: Optional[int] = None,
    detail: Optional[str] = None,
    label: Optional[str] = None,
    engine: Optional[str] = None,
    reason: Optional[str] = None,
) -> None:
    with _lock:
        task = _running.get(task_id)
        if task is None:
            return
        if done is not None:
            task.done = done
        if total is not None:
            task.total = total
        if detail is not None:
            task.detail = detail
        if label is not None:
            task.label = label
        if engine is not None:
            task.engine = engine
        if reason is not None:
            task.reason = reason


def finish(
    task_id: str,
    status: str = "completed",
    *,
    error: Optional[str] = None,
    detail: Optional[str] = None,
) -> None:
    with _lock:
        task = _running.pop(task_id, None)
        if task is None:
            return
        task.status = status
        task.finished_at = time.time()
        if error is not None:
            task.error = error
        if detail is not None:
            task.detail = detail
        _recent.appendleft(task)


def discard(task_id: str) -> None:
    """Drop a running task without recording it in recent history."""
    with _lock:
        _running.pop(task_id, None)


@contextmanager
def track(
    kind: str,
    label: str,
    *,
    reason: Optional[str] = None,
    engine: Optional[str] = None,
    detail: Optional[str] = None,
    video_id: Optional[int] = None,
    total: Optional[int] = None,
    done: Optional[int] = None,
    group: Optional[str] = None,
) -> Generator[ActivityHandle, None, None]:
    handle = start(
        kind,
        label,
        reason=reason,
        engine=engine,
        detail=detail,
        video_id=video_id,
        total=total,
        done=done,
        group=group,
    )
    try:
        yield handle
    except Exception as exc:  # noqa: BLE001
        if not handle._closed:
            handle.finish(status="failed", error=str(exc)[:500])
        raise
    else:
        if not handle._closed:
            handle.finish(status="completed")


def note_queued(kind: str, delta: int = 1) -> None:
    """Adjust extra queued count for a kind (e.g. sprites waiting on semaphore)."""
    with _lock:
        cur = _queued_extra.get(kind, 0) + delta
        if cur <= 0:
            _queued_extra.pop(kind, None)
        else:
            _queued_extra[kind] = cur


def queued_extra(kind: str) -> int:
    with _lock:
        return int(_queued_extra.get(kind, 0))


def _safe_queue_counts() -> dict[str, int]:
    """Pull queued depths from other subsystems; never raise into the API."""
    out: dict[str, int] = {}
    with _lock:
        out.update({k: int(v) for k, v in _queued_extra.items() if v > 0})

    try:
        from .ai import worker as ai_worker

        depth = int(ai_worker.queue_depth())
        # Subtract the running job so "queued" means waiting, not in-flight.
        running = 1 if ai_worker.current_job_info() else 0
        waiting = max(0, depth - running)
        if waiting:
            out["ai"] = out.get("ai", 0) + waiting
    except Exception:  # noqa: BLE001
        pass

    try:
        from .channel_catalog import get_runtime_status

        status = get_runtime_status()
        qd = int(status.get("queue_depth") or 0)
        # queue_depth includes the currently indexing catalog; show waiting only.
        if status.get("running"):
            qd = max(0, qd - 1)
        if qd:
            out["catalog"] = out.get("catalog", 0) + qd
    except Exception:  # noqa: BLE001
        pass

    try:
        from .downloader import download_queue

        qd = int(download_queue.queued_count())
        if qd:
            out["download"] = out.get("download", 0) + qd
    except Exception:  # noqa: BLE001
        pass

    return out


def snapshot() -> dict[str, Any]:
    with _lock:
        running = [t.to_dict() for t in sorted(_running.values(), key=lambda t: t.started_at)]
        recent = [t.to_dict() for t in list(_recent)]
    return {
        "running": running,
        "recent": recent,
        "queued": _safe_queue_counts(),
    }


def iter_running() -> Iterator[ActivityTask]:
    with _lock:
        return iter(list(_running.values()))
