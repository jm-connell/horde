"""Prometheus text exposition for ``GET /api/metrics``.

Hand-rolled (the format is a few lines of text) so there is no new dependency. Every
value comes from memory, a handful of ``GROUP BY`` queries or a ``stat`` call, so a
scrape every 15 s costs next to nothing.
"""

from __future__ import annotations

import logging
import shutil
import threading
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from sqlalchemy import func
from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR
from ..models import (
    AiJob,
    AiJobStatus,
    ChannelCatalog,
    ChannelCatalogStatus,
    DownloadJob,
    JobStatus,
    Video,
)
from . import backup

logger = logging.getLogger(__name__)

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


class RequestStats:
    """Counts HTTP responses by status class and sums their latency.

    One instance lives on ``app.state`` (created by ``install_security``), so every
    app, including each test app, has its own.
    """

    CLASSES = ("1xx", "2xx", "3xx", "4xx", "5xx")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counts = dict.fromkeys(self.CLASSES, 0)
        self._seconds = 0.0

    def record(self, status: int, seconds: float) -> None:
        klass = f"{status // 100}xx"
        with self._lock:
            if klass in self._counts:
                self._counts[klass] += 1
            self._seconds += seconds

    def snapshot(self) -> tuple[dict[str, int], float]:
        with self._lock:
            return dict(self._counts), self._seconds


def _label_value(value: object) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


class _Exposition:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def metric(
        self,
        name: str,
        help_text: str,
        kind: str,
        samples: Iterable[tuple[dict[str, str], float | int]],
    ) -> None:
        self.lines.append(f"# HELP {name} {help_text}")
        self.lines.append(f"# TYPE {name} {kind}")
        for labels, value in samples:
            if labels:
                rendered = ",".join(
                    f'{key}="{_label_value(val)}"' for key, val in labels.items()
                )
                self.lines.append(f"{name}{{{rendered}}} {value}")
            else:
                self.lines.append(f"{name} {value}")

    def text(self) -> str:
        return "\n".join(self.lines) + "\n"


def _status_counts(engine: Engine, column: Any) -> dict[str, int]:
    with Session(engine) as session:
        rows = session.exec(select(column, func.count()).group_by(column)).all()
    return {getattr(status, "value", str(status)): int(n) for status, n in rows}


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def render_metrics(app: FastAPI, engine: Engine) -> str:
    """The full exposition text."""
    from . import downloader

    out = _Exposition()

    jobs = _status_counts(engine, DownloadJob.status)
    out.metric(
        "horde_download_jobs",
        "Download jobs by status.",
        "gauge",
        ((({"status": s.value}), jobs.get(s.value, 0)) for s in JobStatus),
    )
    out.metric(
        "horde_download_queue_paused",
        "1 while the download queue is paused.",
        "gauge",
        [({}, int(downloader.download_queue.is_paused()))],
    )
    ai_jobs = _status_counts(engine, AiJob.status)
    out.metric(
        "horde_ai_jobs",
        "AI jobs by status.",
        "gauge",
        ((({"status": s.value}), ai_jobs.get(s.value, 0)) for s in AiJobStatus),
    )
    catalogs = _status_counts(engine, ChannelCatalog.status)
    out.metric(
        "horde_catalog_channels",
        "Channel catalogs by status (queued and indexing form the catalog queue).",
        "gauge",
        (
            (({"status": s.value}), catalogs.get(s.value, 0))
            for s in ChannelCatalogStatus
        ),
    )
    with Session(engine) as session:
        videos = int(session.scalar(select(func.count(Video.id))) or 0)
    out.metric(
        "horde_library_videos", "Videos in the library.", "gauge", [({}, videos)]
    )

    registry = getattr(app.state, "workers", None)
    workers = registry.status() if registry is not None else {}
    out.metric(
        "horde_worker_up",
        "1 when the background worker is running (or finished its one-shot job).",
        "gauge",
        (({"worker": name}, int(ok)) for name, ok in sorted(workers.items())),
    )

    db_file = engine.url.database
    if db_file and db_file != ":memory:":
        db_path = Path(db_file)
        out.metric(
            "horde_db_size_bytes",
            "Size of the SQLite database file and its write-ahead log.",
            "gauge",
            [
                ({"file": "db"}, _file_size(db_path)),
                ({"file": "wal"}, _file_size(db_path.with_name(db_path.name + "-wal"))),
            ],
        )
    latest = backup.latest_nightly(engine)
    out.metric(
        "horde_last_backup_timestamp_seconds",
        "Modification time of the newest nightly backup (0 when there is none).",
        "gauge",
        [({}, int(latest.stat().st_mtime) if latest is not None else 0)],
    )

    disk_samples: list[tuple[dict[str, str], float | int]] = []
    for label, path in (("downloads", DOWNLOADS_DIR), ("data", Path(db_file or "."))):
        target = path if path.is_dir() else path.parent
        try:
            usage = shutil.disk_usage(target)
        except OSError:
            logger.debug("disk usage unavailable for %s", target, exc_info=True)
            continue
        disk_samples.append(({"volume": label, "kind": "free"}, usage.free))
        disk_samples.append(({"volume": label, "kind": "total"}, usage.total))
    out.metric(
        "horde_disk_bytes",
        "Free and total bytes of the volume holding the downloads and the data folder.",
        "gauge",
        disk_samples,
    )

    stats = getattr(app.state, "request_stats", None)
    if stats is not None:
        counts, seconds = stats.snapshot()
        out.metric(
            "horde_http_requests_total",
            "HTTP responses by status class.",
            "counter",
            (({"status_class": klass}, n) for klass, n in counts.items()),
        )
        out.metric(
            "horde_http_request_seconds_total",
            "Total time spent handling HTTP requests.",
            "counter",
            [({}, round(seconds, 6))],
        )
    return out.text()
