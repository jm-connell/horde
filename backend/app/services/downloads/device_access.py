"""Who may see and fetch a device-destination download job.

A device job is a file staged on the server for one account's browser to save.
Its requester (``DownloadRequester``) and administrators always see it; anyone
else sees it while the requester shares downloads (``users.share_downloads``).
Jobs nobody requested (automatic ones) and library jobs are visible as before.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlmodel import Session, col, select

from ...models import DownloadDestination, DownloadJob, DownloadRequester, User
from ..auth.accounts import AuthUser


def _is_device(job: DownloadJob) -> bool:
    return job.destination == DownloadDestination.device.value


def hidden_job_ids(
    session: Session, user: AuthUser, jobs: Iterable[DownloadJob]
) -> set[int]:
    """The ids among ``jobs`` that ``user`` may not see."""
    if user.is_admin:
        return set()
    device_ids = [j.id for j in jobs if j.id is not None and _is_device(j)]
    if not device_ids:
        return set()
    rows = session.exec(
        select(
            DownloadRequester.job_id, DownloadRequester.user_id, User.share_downloads
        )
        .join(User, col(User.id) == col(DownloadRequester.user_id))
        .where(col(DownloadRequester.job_id).in_(device_ids))
    ).all()
    return {
        job_id
        for job_id, requester_id, shares in rows
        if requester_id != user.id and not shares
    }


def can_access(session: Session, user: AuthUser, job: DownloadJob) -> bool:
    return job.id not in hidden_job_ids(session, user, [job])
