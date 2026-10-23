"""Turn an event and its payloads into the words of one notification.

``render`` takes every payload the event gathered for a target in one go (a single
one, or a burst folded into a summary) and returns a ``Message``; ``delivery.py``
shapes that for ntfy, a webhook or Discord.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from . import events

#: How many titles a summary lists before "and N more".
SUMMARY_LISTED = 5
#: How many payloads a webhook's ``data.items`` carries.
MAX_ITEMS = 50
_TITLE_MAX = 120
_LINE_MAX = 200
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")


@dataclass(frozen=True)
class Message:
    event: str
    title: str
    body: str
    #: Where in Horde to look (``/download``), or None.
    path: str | None = None
    #: Failures and stalls ask for attention (ntfy priority "high").
    urgent: bool = False
    #: ntfy emoji short codes shown next to the title.
    tags: tuple[str, ...] = ()
    #: The payloads behind it, for webhooks.
    data: dict[str, Any] = field(default_factory=dict)


def clean(value: Any, limit: int = _LINE_MAX) -> str:
    """One line of text: control characters (newlines included) become spaces."""
    text = _CONTROL.sub(" ", str(value if value is not None else "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _name(payload: dict[str, Any]) -> str:
    return clean(payload.get("title") or "A video", _TITLE_MAX)


def _listing(lines: list[str], total: int | None = None) -> str:
    """The first few ``lines`` and "and N more" for the rest of ``total`` (default: all)."""
    shown = lines[:SUMMARY_LISTED]
    extra = max(total or 0, len(lines)) - len(shown)
    if extra > 0:
        shown.append(f"and {extra} more")
    return "\n".join(shown)


def _count(value: Any, fallback: int) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else fallback


def _single_or_many(count: int, one: str, many: str) -> str:
    return one if count == 1 else many.format(n=count)


def render(
    event: str, payloads: list[dict[str, Any]], total: int | None = None
) -> Message:
    """The notification for ``payloads`` (at least one) of ``event``.

    ``total`` is how many occurrences there were when only some of their payloads
    were kept (a burst larger than the notifier's cap).
    """
    if not payloads:
        raise ValueError("render needs at least one payload")
    count = max(total or 0, len(payloads))
    first = payloads[0]
    data = {"count": count, "items": payloads[:MAX_ITEMS]}

    if event == events.DOWNLOAD_FAILED:
        if count == 1:
            channel = clean(first.get("channel"), _TITLE_MAX)
            reason = clean(first.get("error") or "Unknown error")
            body = f"{channel} — {reason}" if channel else reason
            title = f"Download failed: {_name(first)}"
        else:
            title = f"{count} downloads failed"
            body = _listing(
                [
                    f"{_name(p)}: {clean(p.get('error') or 'Unknown error')}"
                    for p in payloads
                ],
                count,
            )
        return Message(
            event, title, body, "/download", urgent=True, tags=("warning",), data=data
        )

    if event == events.DOWNLOAD_COMPLETED:
        if count == 1:
            channel = clean(first.get("channel"), _TITLE_MAX)
            vid = first.get("video_id")
            return Message(
                event,
                f"Downloaded: {_name(first)}",
                channel or "Added to the library.",
                f"/watch/{vid}" if isinstance(vid, int) else "/",
                tags=("white_check_mark",),
                data=data,
            )
        return Message(
            event,
            f"{count} new videos downloaded",
            _listing([_name(p) for p in payloads], count),
            "/",
            tags=("white_check_mark",),
            data=data,
        )

    if event == events.QUEUE_HELD:
        reason = clean(first.get("reason") or "Downloads are waiting for disk space.")
        return Message(
            event,
            "Downloads paused",
            reason,
            "/download",
            urgent=True,
            tags=("pause_button",),
            data=data,
        )

    if event == events.UPDATE_AVAILABLE:
        latest = clean(first.get("latest") or "A new version", 40)
        current = clean(first.get("current"), 40)
        body = f"Horde {latest} is available."
        if current:
            body += f" This server runs {current}."
        return Message(
            event,
            "Horde update available",
            body,
            "/settings?tab=system",
            tags=("arrow_up",),
            data=data,
        )

    if event == events.UPDATE_FAILED:
        state = first.get("state")
        rolled_back = state == "rolled_back"
        return Message(
            event,
            "Horde update rolled back" if rolled_back else "Horde update failed",
            "The update did not work and the previous version was put back."
            if rolled_back
            else "The update did not finish. See the log in Settings → System.",
            "/settings?tab=system",
            urgent=True,
            tags=("x",),
            data=data,
        )

    if event == events.CHANNEL_LIVE:
        if count == 1:
            channel = clean(first.get("channel") or "A channel", _TITLE_MAX)
            return Message(
                event,
                f"{channel} is live",
                clean(first.get("title") or "A live broadcast started."),
                "/",
                tags=("red_circle",),
                data=data,
            )
        return Message(
            event,
            _single_or_many(count, "A channel is live", "{n} channels went live"),
            _listing(
                [clean(p.get("channel") or "A channel", _TITLE_MAX) for p in payloads],
                count,
            ),
            "/",
            tags=("red_circle",),
            data=data,
        )

    if event == events.LOGIN_FAILURES:
        name = clean(first.get("username") or "an account", _TITLE_MAX)
        failures = _count(first.get("count"), 1)
        addresses = _count(first.get("addresses"), 1)
        return Message(
            event,
            f"Failed sign-ins for {name}",
            f"{failures} failed sign-ins in the last hour from "
            f"{_single_or_many(addresses, 'one address', '{n} addresses')}.",
            "/account",
            urgent=True,
            tags=("rotating_light",),
            data=data,
        )

    if event == events.NEW_DEVICE_SIGN_IN:
        name = clean(first.get("username") or "An account", _TITLE_MAX)
        device = clean(first.get("device") or "an unknown device", _TITLE_MAX)
        address = clean(first.get("address"), 64)
        return Message(
            event,
            f"New sign-in for {name}",
            f"{device}" + (f" from {address}" if address else ""),
            "/account",
            tags=("key",),
            data=data,
        )

    raise ValueError(f"no wording for event {event!r}")


def sample() -> Message:
    """The message "Send test" sends."""
    return Message(
        "test",
        "Horde test notification",
        "If you can read this, this target works.",
        "/settings?tab=system",
        tags=("bell",),
        data={"count": 1, "items": [{"test": True}]},
    )
