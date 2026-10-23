"""Notification targets (ntfy, webhook, Discord): list, add, change, remove, test."""

from typing import Any

from fastapi import APIRouter, Depends

from .. import config
from ..auth import require_admin
from ..errors import CodedHTTPException
from ..response_schemas import OkResponse
from ..schemas import (
    NotificationEventOptionRead,
    NotificationEventRead,
    NotificationsRead,
    NotificationTargetCreate,
    NotificationTargetRead,
    NotificationTargetTest,
    NotificationTargetUpdate,
    NotificationTestResult,
)
from ..services.notifications import delivery, events, render, targets

router = APIRouter(
    prefix="/api/notifications",
    tags=["notifications"],
    dependencies=[Depends(require_admin)],
)


def _read(target: dict[str, Any]) -> NotificationTargetRead:
    token = str(target.get("token") or "")
    return NotificationTargetRead(
        id=target["id"],
        name=target["name"],
        kind=target["kind"],
        url=target["url"],
        topic=target.get("topic"),
        token=targets.mask_token(token),
        token_set=bool(token),
        enabled=bool(target.get("enabled")),
        events=list(target.get("events") or []),
        options=dict(target.get("options") or {}),
    )


def _event_read(spec: events.EventSpec) -> NotificationEventRead:
    return NotificationEventRead(
        name=spec.name,
        label=spec.label,
        description=spec.description,
        default=spec.default,
        options=[
            NotificationEventOptionRead(
                key=o.key, label=o.label, description=o.description, default=o.default
            )
            for o in spec.options
        ],
    )


@router.get("", response_model=NotificationsRead)
def get_notifications():
    return NotificationsRead(
        targets=[_read(t) for t in targets.list_targets()],
        events=[_event_read(spec) for spec in events.EVENTS],
        max_targets=targets.MAX_TARGETS,
        public_url_set=bool(config.PUBLIC_URL),
    )


@router.post("/targets", response_model=NotificationTargetRead)
def create_target(payload: NotificationTargetCreate):
    return _read(targets.create_target(payload.model_dump()))


@router.patch("/targets/{target_id}", response_model=NotificationTargetRead)
def update_target(target_id: str, payload: NotificationTargetUpdate):
    return _read(
        targets.update_target(target_id, payload.model_dump(exclude_unset=True))
    )


@router.delete("/targets/{target_id}", response_model=OkResponse)
def delete_target(target_id: str):
    targets.delete_target(target_id)
    return OkResponse()


def _try(target: dict[str, Any]) -> NotificationTestResult:
    try:
        status = delivery.send(target, render.sample())
    except delivery.DeliveryError as exc:
        return NotificationTestResult(
            ok=False, status_code=exc.status_code, error=str(exc)
        )
    return NotificationTestResult(ok=True, status_code=status)


@router.post("/targets/{target_id}/test", response_model=NotificationTestResult)
def test_saved_target(target_id: str):
    """Send a sample notification to a saved target."""
    target = targets.get_target(target_id)
    if target is None:
        raise CodedHTTPException(
            404,
            "That notification target does not exist",
            "notification_target_not_found",
        )
    return _try(target)


@router.post("/test", response_model=NotificationTestResult)
def test_unsaved_target(payload: NotificationTargetTest):
    """Send a sample notification to a target that is not saved yet.

    With ``id`` set and no new token, the saved target's token is used, so editing a
    target can be tried without typing the secret again.
    """
    stored = targets.get_target(payload.id) if payload.id else None
    fields = payload.model_dump(exclude={"id"})
    target = targets.normalize(
        fields, stored_token=str((stored or {}).get("token") or "")
    )
    return _try(target)
