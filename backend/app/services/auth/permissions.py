"""What a member may do. Administrators may do everything.

The names are stable API: they are stored in ``users.permissions`` (a JSON list),
returned by ``/api/auth/state`` and used by the SPA to hide controls. Only add to
the table; never rename.

Not grantable, admin only: user management, server-wide settings, AI provider
configuration and worker control, factory reset, library-wide compatibility
conversion, background and font management, and forcing an update check.
"""

from __future__ import annotations

import json
from dataclasses import dataclass


@dataclass(frozen=True)
class Permission:
    name: str
    label: str
    description: str
    default: bool


PERMISSION_TABLE: tuple[Permission, ...] = (
    Permission(
        "delete_videos",
        "Delete videos",
        "Delete videos from the library and their files from the server, "
        "including bulk delete.",
        False,
    ),
    Permission(
        "download",
        "Download and import",
        "Queue downloads, import playlists, set up channel auto-download and "
        "upload or import files.",
        True,
    ),
    Permission(
        "offline_download",
        "Save for offline",
        "Save videos to this device for offline viewing, and download files "
        "from the server.",
        True,
    ),
    Permission(
        "edit_metadata",
        "Edit details",
        "Edit titles, descriptions, notes, tags and thumbnails, and rename channels.",
        True,
    ),
    Permission(
        "manage_playlists",
        "Manage playlists",
        "Create App-wide playlists and edit or delete the ones other people share. "
        "Everyone can make private playlists and manage their own.",
        True,
    ),
    Permission(
        "use_ai",
        "Use AI",
        "AI chat, on-demand summaries, tags and chapters, and the embedding half of "
        "library and channel-catalog search (these can cost money with a paid "
        "provider).",
        True,
    ),
    Permission(
        "manage_ask",
        "Manage Ask channels",
        "Turn Ask on or off for channels and pause or resume their indexing. "
        "Indexing fetches every upload's captions from YouTube for hours and "
        "uses disk space.",
        False,
    ),
)

ALL_PERMISSIONS: frozenset[str] = frozenset(p.name for p in PERMISSION_TABLE)
DEFAULT_PERMISSIONS: frozenset[str] = frozenset(
    p.name for p in PERMISSION_TABLE if p.default
)


class UnknownPermission(ValueError):
    pass


def validate(names: list[str] | set[str] | frozenset[str]) -> frozenset[str]:
    unknown = sorted(set(names) - ALL_PERMISSIONS)
    if unknown:
        raise UnknownPermission(f"Unknown permission: {', '.join(unknown)}")
    return frozenset(names)


def dump(names: frozenset[str] | set[str]) -> str:
    return json.dumps(sorted(names))


def parse(raw: str | None) -> frozenset[str]:
    """Granted names from the stored JSON; unknown or corrupt entries are ignored."""
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return frozenset()
    if not isinstance(value, list):
        return frozenset()
    return frozenset(str(v) for v in value) & ALL_PERMISSIONS
