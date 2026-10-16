"""Short job-row writes that survive SQLite's "database is locked"."""

import logging
import time
from collections.abc import Callable
from typing import Any

from sqlalchemy.exc import OperationalError
from sqlmodel import Session

from ...context import get_engine
from ...models import DownloadJob

logger = logging.getLogger(__name__)


DB_RETRY_ATTEMPTS = 5


DB_RETRY_BASE_DELAY = 0.25


def retry_db_locked[T](fn: Callable[[], T], *, what: str) -> T:
    """Run a short DB write, retrying "database is locked" with backoff.

    SQLite reports ``locked`` immediately (no busy wait) when a read
    transaction cannot be upgraded because another writer got in first. The
    work is idempotent (each attempt opens a fresh session), so retrying is safe.
    """
    for attempt in range(DB_RETRY_ATTEMPTS):
        try:
            return fn()
        except OperationalError as exc:
            locked = "locked" in str(exc).lower() or "busy" in str(exc).lower()
            if not locked or attempt == DB_RETRY_ATTEMPTS - 1:
                raise
            delay = DB_RETRY_BASE_DELAY * (2**attempt)
            logger.warning(
                "database locked writing %s (attempt %d); retrying in %.2fs",
                what,
                attempt + 1,
                delay,
            )
            time.sleep(delay)
    raise AssertionError("unreachable")  # pragma: no cover


def update_job(job_id: int, **fields: Any) -> None:
    def write() -> None:
        with Session(get_engine()) as session:
            job = session.get(DownloadJob, job_id)
            if job is None:
                return
            for key, value in fields.items():
                setattr(job, key, value)
            session.add(job)
            session.commit()

    retry_db_locked(write, what=f"job {job_id}")
