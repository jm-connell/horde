"""Per-user UI preferences.

Server-wide settings stay in ``app_settings.json`` and are changed by
administrators only. What a person sees (theme, density, default sort, ...) is the
``ui`` blob, which every user owns separately in ``user_settings``. A user's blob
is layered over the server-wide ``ui`` blob, which acts as the default for people
who have not chosen anything yet (and holds what the administrator had before
accounts existed).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any

from sqlmodel import Session

from ..models import UserSettings, utcnow
from . import app_settings
from .ytdlp_formats import normalize_compat_resolution, normalize_video_codec

logger = logging.getLogger(__name__)

#: ``ui`` keys that change what the *server* does (the default download codec and
#: the size of H.264 sidecar copies; see ``ytdlp_formats``). They are shared by
#: everyone, live in the server-wide blob and only an administrator can change
#: them. Everything else in ``ui`` is a personal preference.
#: (Mapped to how each is read, so an unset key compares equal to its default.)
_SERVER_UI_NORMALIZERS: dict[str, Callable[[Any], str]] = {
    "download_video_codec": normalize_video_codec,
    "compat_copy_resolution": normalize_compat_resolution,
}
SERVER_UI_KEYS = frozenset(_SERVER_UI_NORMALIZERS)


def split_ui(ui: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(server-wide keys, personal keys)`` of a ``ui`` mapping."""
    server = {k: v for k, v in ui.items() if k in SERVER_UI_KEYS}
    personal = {k: v for k, v in ui.items() if k not in SERVER_UI_KEYS}
    return server, personal


def changes_shared_ui(shared: dict[str, Any]) -> bool:
    """Whether ``shared`` (server-owned ``ui`` keys) would change what the server does."""
    raw = app_settings.load().get("ui")
    current = raw if isinstance(raw, dict) else {}
    return any(
        _SERVER_UI_NORMALIZERS[k](current.get(k)) != _SERVER_UI_NORMALIZERS[k](v)
        for k, v in shared.items()
    )


def stored_ui(session: Session, user_id: int) -> dict[str, Any]:
    """Only what this user has saved (no defaults)."""
    row = session.get(UserSettings, user_id)
    if row is None:
        return {}
    try:
        value = json.loads(row.ui_json or "{}")
    except json.JSONDecodeError:
        logger.warning("Corrupt ui_json for user %s; ignoring it", user_id)
        return {}
    return split_ui(value)[1] if isinstance(value, dict) else {}


def effective_ui(session: Session, user_id: int) -> dict[str, Any]:
    """The server-wide defaults with the user's own choices on top.

    Server-owned keys always come from the server-wide blob.
    """
    raw = app_settings.load().get("ui")
    shared, defaults = split_ui(raw if isinstance(raw, dict) else {})
    return {**defaults, **stored_ui(session, user_id), **shared}


def save_ui(session: Session, user_id: int, patch: dict[str, Any]) -> dict[str, Any]:
    """Merge ``patch`` into the user's saved preferences and return the effective ui."""
    merged = {**stored_ui(session, user_id), **split_ui(patch)[1]}
    row = session.get(UserSettings, user_id)
    if row is None:
        row = UserSettings(user_id=user_id)
    row.ui_json = json.dumps(merged, ensure_ascii=False)
    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    return effective_ui(session, user_id)
