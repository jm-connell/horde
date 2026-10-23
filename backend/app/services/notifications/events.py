"""Every event a notification target can subscribe to.

This registry is the one place an event is declared: its name, the label and
description the Settings screen shows (it reads them from ``GET /api/notifications``),
whether a new target subscribes to it by default, and whether a burst of it is
folded into one summary. To add an event, add an ``EventSpec`` here, emit it with
``notifications.emit("<name>", {...})`` and teach ``render.py`` its wording.
"""

from __future__ import annotations

from dataclasses import dataclass

DOWNLOAD_FAILED = "download_failed"
DOWNLOAD_COMPLETED = "download_completed"
QUEUE_HELD = "queue_held"
UPDATE_AVAILABLE = "update_available"
UPDATE_FAILED = "update_failed"
CHANNEL_LIVE = "channel_live"
LOGIN_FAILURES = "login_failures"
NEW_DEVICE_SIGN_IN = "new_device_sign_in"

#: ``download_completed``: only count jobs Horde queued by itself (channel
#: auto-download, subscribed playlists), not ones somebody watched happen.
ONLY_AUTOMATIC = "only_automatic"


@dataclass(frozen=True)
class EventOption:
    """A yes/no choice a target makes about one event."""

    key: str
    label: str
    description: str
    default: bool


@dataclass(frozen=True)
class EventSpec:
    name: str
    label: str
    description: str
    #: Subscribed to by a newly added target.
    default: bool
    #: A burst becomes one summary per target per minute instead of one message each.
    coalesce: bool = False
    options: tuple[EventOption, ...] = ()


EVENTS: tuple[EventSpec, ...] = (
    EventSpec(
        DOWNLOAD_FAILED,
        "Download failed",
        "A download gave up, with the video and the reason.",
        default=True,
        coalesce=True,
    ),
    EventSpec(
        DOWNLOAD_COMPLETED,
        "Download finished",
        "A video finished downloading into the library.",
        default=False,
        coalesce=True,
        options=(
            EventOption(
                ONLY_AUTOMATIC,
                "Only automatic downloads",
                "Skip downloads you queued yourself; report channel auto-downloads "
                "and subscribed playlists.",
                default=True,
            ),
        ),
    ),
    EventSpec(
        QUEUE_HELD,
        "Downloads paused for disk space",
        "The queue is waiting because the library is full or the disk is nearly full.",
        default=True,
    ),
    EventSpec(
        UPDATE_AVAILABLE,
        "Update available",
        "A new Horde release is out.",
        default=False,
    ),
    EventSpec(
        UPDATE_FAILED,
        "Update failed",
        "The Update now button failed or was rolled back.",
        default=True,
    ),
    EventSpec(
        CHANNEL_LIVE,
        "Followed channel went live",
        "A channel somebody follows started a live broadcast.",
        default=False,
        coalesce=True,
    ),
    EventSpec(
        LOGIN_FAILURES,
        "Failed sign-ins",
        "Many failed sign-ins for one account within an hour: someone is guessing. "
        "At most one message per account per hour.",
        default=True,
    ),
    EventSpec(
        NEW_DEVICE_SIGN_IN,
        "Sign-in from a new device",
        "Somebody signed in from a browser or device their account was not already "
        "signed in on. Every account counts, so it can be chatty on a shared server.",
        default=False,
    ),
)

_BY_NAME = {spec.name: spec for spec in EVENTS}

EVENT_NAMES: frozenset[str] = frozenset(_BY_NAME)
OPTION_KEYS: frozenset[str] = frozenset(o.key for s in EVENTS for o in s.options)


def get(name: str) -> EventSpec | None:
    return _BY_NAME.get(name)


def default_events() -> list[str]:
    return [spec.name for spec in EVENTS if spec.default]


def default_options() -> dict[str, bool]:
    return {o.key: o.default for spec in EVENTS for o in spec.options}
