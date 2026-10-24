"""The notification targets an administrator configured, kept in the JSON settings.

A target is a plain dict::

    {id, name, kind, url, topic, token, enabled, events: [...], options: {...}}

``token`` is the main secret (an ntfy access token, or the bearer token a webhook
expects). It is stored here and never leaves the server: the API shows the last four
characters, like the OpenRouter key. A Discord webhook's URL carries its own secret,
the last path segment, which the API masks the same way.
"""

from __future__ import annotations

import re
import uuid
from typing import Any
from urllib.parse import urlsplit

from ...errors import CodedHTTPException
from .. import app_settings
from . import events
from .delivery import KIND_DISCORD, KIND_NTFY, KINDS, validate_address

MAX_TARGETS = 10
NAME_MAX = 60
URL_MAX = 2048
_TOPIC = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_TOKEN = re.compile(r"[\x21-\x7e]{1,512}")
#: What the form sends back for a token it did not change.
_MASK_PREFIXES = ("••••", "****")

#: ``/api/webhooks/<id>/<token>``: the token is what lets anyone post to the channel.
_DISCORD_TOKEN = re.compile(r"(/api/webhooks/\d+/)([^/?#\s]+)")

CODE_INVALID = "invalid_notification_target"


def _invalid(detail: str) -> CodedHTTPException:
    return CodedHTTPException(422, detail, CODE_INVALID)


def mask_token(token: str) -> str:
    """``••••abcd``: enough to tell two tokens apart, nothing that can be used."""
    if not token:
        return ""
    return "••••" if len(token) <= 4 else f"••••{token[-4:]}"


def mask_url(url: str, kind: str) -> str:
    """``url`` as the API shows it: a Discord webhook's token segment masked."""
    if kind != KIND_DISCORD:
        return url
    return _DISCORD_TOKEN.sub(lambda m: m.group(1) + mask_token(m.group(2)), url)


def _is_masked_url(url: str) -> bool:
    match = _DISCORD_TOKEN.search(url)
    return match is not None and match.group(2).startswith(_MASK_PREFIXES)


def _host(url: str) -> tuple[str | None, int | None]:
    parts = urlsplit(url)
    return (parts.hostname or "").lower(), parts.port


def _token_required() -> CodedHTTPException:
    return CodedHTTPException(
        400,
        "This sends the saved credentials to a different address. Enter the "
        "access token (or the Discord address) again to confirm",
        "token_required",
    )


def keeps_token(value: str | None) -> bool:
    """True when ``value`` means "leave the stored token alone"."""
    return value is None or value.strip().startswith(_MASK_PREFIXES)


def normalize(
    fields: dict[str, Any], *, stored_token: str = "", stored_url: str = ""
) -> dict[str, Any]:
    """A complete, validated target (without ``id``) from form ``fields``.

    ``stored_token`` is kept when ``fields`` leaves the token out or sends the mask;
    ``stored_url`` likewise stands in for a Discord address sent back masked. Neither
    secret is ever combined with a different host than the one it was saved for:
    that needs the secret typed again (``token_required``).
    """
    name = str(fields.get("name") or "").strip()
    if not name or len(name) > NAME_MAX:
        raise _invalid(f"Give the target a name of 1 to {NAME_MAX} characters")
    kind = fields.get("kind")
    if kind not in KINDS:
        raise _invalid("Choose ntfy, webhook or Discord")
    try:
        url = validate_address(str(fields.get("url") or ""))
    except ValueError as exc:
        raise _invalid(str(exc)) from exc
    if len(url) > URL_MAX:
        raise _invalid("That URL is too long")
    if kind == KIND_DISCORD and _is_masked_url(url):
        if not stored_url or mask_url(stored_url, KIND_DISCORD) != url:
            raise _token_required()
        url = stored_url

    topic = None
    if kind == KIND_NTFY:
        topic = str(fields.get("topic") or "").strip()
        if not _TOPIC.fullmatch(topic):
            raise _invalid(
                "ntfy needs a topic: 1 to 64 letters, digits, dashes, dots or underscores"
            )

    raw_token = fields.get("token")
    if kind == KIND_DISCORD:
        token = ""  # a Discord webhook URL carries its own secret
    elif keeps_token(raw_token):
        if stored_token and stored_url and _host(url) != _host(stored_url):
            raise _token_required()
        token = stored_token
    else:
        token = str(raw_token).strip()
        if token and not _TOKEN.fullmatch(token):
            raise _invalid("The access token cannot contain spaces or line breaks")

    chosen = fields.get("events")
    names = events.default_events() if chosen is None else list(chosen)
    unknown = sorted(set(names) - events.EVENT_NAMES)
    if unknown:
        raise _invalid(f"Unknown event: {unknown[0]}")
    subscribed = [spec.name for spec in events.EVENTS if spec.name in names]

    options = events.default_options()
    given = fields.get("options") or {}
    unknown_options = sorted(set(given) - events.OPTION_KEYS)
    if unknown_options:
        raise _invalid(f"Unknown option: {unknown_options[0]}")
    options.update({k: bool(v) for k, v in given.items()})

    return {
        "name": name,
        "kind": kind,
        "url": url,
        "topic": topic,
        "token": token,
        "enabled": bool(fields.get("enabled", True)),
        "events": subscribed,
        "options": options,
    }


def list_targets() -> list[dict[str, Any]]:
    stored = app_settings.load().get("notification_targets")
    return (
        [t for t in stored if isinstance(t, dict)] if isinstance(stored, list) else []
    )


def get_target(target_id: str) -> dict[str, Any] | None:
    return next((t for t in list_targets() if t.get("id") == target_id), None)


def _not_found() -> CodedHTTPException:
    return CodedHTTPException(
        404, "That notification target does not exist", "notification_target_not_found"
    )


def create_target(fields: dict[str, Any]) -> dict[str, Any]:
    target = {"id": uuid.uuid4().hex[:12], **normalize(fields)}

    def add(current: dict[str, Any]) -> dict[str, Any]:
        existing = current.get("notification_targets") or []
        if len(existing) >= MAX_TARGETS:
            raise CodedHTTPException(
                409,
                f"You can have at most {MAX_TARGETS} notification targets",
                "notification_limit",
            )
        return {"notification_targets": [*existing, target]}

    app_settings.edit(add)
    return target


def update_target(target_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    """Apply the fields ``patch`` names; the rest stay as they are."""
    result: dict[str, Any] = {}

    def change(current: dict[str, Any]) -> dict[str, Any]:
        rows = list(current.get("notification_targets") or [])
        for index, row in enumerate(rows):
            if row.get("id") != target_id:
                continue
            base = {k: v for k, v in row.items() if k != "token"}
            merged = normalize(
                {**base, **patch},
                stored_token=str(row.get("token") or ""),
                stored_url=str(row.get("url") or ""),
            )
            result.update({"id": target_id, **merged})
            rows[index] = result
            return {"notification_targets": rows}
        raise _not_found()

    app_settings.edit(change)
    return result


def delete_target(target_id: str) -> None:
    def remove(current: dict[str, Any]) -> dict[str, Any]:
        rows = list(current.get("notification_targets") or [])
        kept = [r for r in rows if r.get("id") != target_id]
        if len(kept) == len(rows):
            raise _not_found()
        return {"notification_targets": kept}

    app_settings.edit(remove)


def subscribers(event: str, payload: dict[str, Any]) -> list[str]:
    """Ids of the enabled targets that want ``event`` with this ``payload``."""
    ids: list[str] = []
    for target in list_targets():
        if not target.get("enabled") or event not in (target.get("events") or []):
            continue
        options = target.get("options") or {}
        if (
            event == events.DOWNLOAD_COMPLETED
            and options.get(events.ONLY_AUTOMATIC, True)
            and payload.get("origin", "manual") == "manual"
        ):
            continue
        ids.append(str(target["id"]))
    return ids
