"""What ``/api/health`` and ``/api/ready`` report, and the caches that keep it cheap.

``/api/health`` is polled every couple of seconds by the UI and ``update.sh``, so it
must not fork a process or wait on the network. Everything slow is computed once at
startup (yt-dlp version, git SHA, ffmpeg build info) or refreshed in the background
(the PO-token sidecar ping, every ``POT_TTL_SEC``). The handler only reads memory and
runs three COUNT queries.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from ..config import YTDLP_POT_BASE_URL, resolve_git_sha
from ..migrations.runner import head_revision, stored_revision
from ..schemas import ReadyResponse
from .workers import BackgroundWorker

logger = logging.getLogger(__name__)

POT_TTL_SEC = 30.0
POT_TIMEOUT_SEC = 2.0
#: Written by the Dockerfile: ``key=value`` lines (ffmpeg_flavor, ffmpeg: the first line of `ffmpeg -version`).
BUILD_INFO_PATH = Path("/app/BUILD_INFO")


def read_build_info(path: Path = BUILD_INFO_PATH) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    info: dict[str, str] = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip():
            info[key.strip()] = value.strip()
    return info


def ytdlp_version() -> str:
    """The yt-dlp the app actually runs (the imported library, no subprocess)."""
    try:
        from yt_dlp.version import __version__
    except ImportError:
        logger.warning("yt-dlp is not importable", exc_info=True)
        return "unknown"
    return str(__version__)


class HealthCache:
    """Values that are expensive to compute and change rarely or never."""

    def __init__(
        self,
        *,
        pot_base_url: str = YTDLP_POT_BASE_URL,
        build_info_path: Path = BUILD_INFO_PATH,
    ) -> None:
        self.pot_base_url = pot_base_url
        self.git_sha = resolve_git_sha()
        self.ytdlp_version = ytdlp_version()
        #: The newest migration this code ships (read once; /api/ready compares to it).
        self.head_revision = head_revision()
        self.build_info = read_build_info(build_info_path)
        self._pot: dict[str, Any] | None = None
        self._pot_lock = threading.Lock()

    def ffmpeg(self) -> dict[str, str | None] | None:
        flavor = self.build_info.get("ffmpeg_flavor")
        version = self.build_info.get("ffmpeg")
        if not flavor and not version:
            return None
        return {"flavor": flavor, "version": version}

    def pot_status(self) -> dict[str, Any] | None:
        if not self.pot_base_url:
            return None
        with self._pot_lock:
            if self._pot is not None:
                return dict(self._pot)
        return {"status": "pending", "url": self.pot_base_url, "detail": "Checking"}

    def refresh_pot(self) -> None:
        """Ping the sidecar (blocking, up to ``POT_TIMEOUT_SEC``) and keep the result."""
        if not self.pot_base_url:
            return
        url = f"{self.pot_base_url.rstrip('/')}/ping"
        try:
            response = httpx.get(url, timeout=POT_TIMEOUT_SEC)
            if response.is_success:
                status: dict[str, Any] = {
                    "status": "ok",
                    "url": self.pot_base_url,
                    "version": response.json().get("version"),
                }
            else:
                status = {
                    "status": "error",
                    "url": self.pot_base_url,
                    "detail": f"HTTP {response.status_code}",
                }
        except (httpx.HTTPError, ValueError) as exc:
            status = {"status": "error", "url": self.pot_base_url, "detail": str(exc)}
        with self._pot_lock:
            self._pot = status

    def create_pot_worker(self) -> BackgroundWorker:
        def loop(worker: BackgroundWorker) -> None:
            while True:
                self.refresh_pot()
                if worker.sleep(POT_TTL_SEC):
                    return

        return BackgroundWorker("pot-probe", loop, stop_timeout=POT_TIMEOUT_SEC + 1)


def build_readiness(
    app: FastAPI, engine: Engine, head_revision: str | None
) -> ReadyResponse:
    """Can this instance serve? Database reachable, schema at head, workers up.

    Without a lifespan (tests, tools) there is no registry and no workers to check.
    Once shutdown has begun the answer is always "not ready", so a load balancer
    stops sending traffic while the workers wind down.
    """
    problems: list[str] = []
    database = False
    migrations = False
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("SELECT 1")
        database = True
        migrations = stored_revision(engine) == head_revision
        if not migrations:
            problems.append("database is not at the latest migration")
    except SQLAlchemyError:
        logger.warning("readiness: database check failed", exc_info=True)
        problems.append("database unreachable")
    shutdown = getattr(app.state, "shutdown_event", None)
    if shutdown is not None and shutdown.is_set():
        problems.append("shutting down")
    registry = getattr(app.state, "workers", None)
    workers = registry.status() if registry is not None else {}
    problems.extend(
        f"worker {name} is not running" for name, ok in workers.items() if not ok
    )
    return ReadyResponse(
        ready=not problems,
        database=database,
        migrations=migrations,
        workers=workers,
        problems=problems,
    )
