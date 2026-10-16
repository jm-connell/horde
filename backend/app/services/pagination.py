"""Opaque cursors for the list endpoints.

A cursor is a small JSON object, URL-safe base64 encoded, so clients treat it as a
token and the server can change what it carries. Two kinds exist:

* ``keyset``: the sort value and id of the last row returned. The next page is
  "everything after that row" in the active sort order, so rows added or removed
  between requests never shift a page (offset paging would repeat or skip them).
* ``offset``: a position in an ordering the database cannot express, such as the
  seeded shuffle of ``sort=random`` or the ranked merge of keyword and semantic
  search hits.

The cursor also records the ``sort`` and ``order`` it was made for; replaying it
with different ones is refused instead of returning an arbitrary page.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

DEFAULT_LIMIT = 100
MAX_LIMIT = 500


class InvalidCursor(ValueError):
    """The cursor is malformed or does not belong to this query."""


@dataclass(frozen=True)
class PageRequest:
    """Where to start and how many rows to return."""

    limit: int = DEFAULT_LIMIT
    kind: Literal["keyset", "offset"] = "keyset"
    #: keyset: the sort value of the last row seen (``None`` is a real value for
    #: nullable sort columns; ``has_position`` tells "first page" apart).
    value: Any = None
    after_id: int | None = None
    #: offset: rows to skip.
    offset: int = 0
    #: seeded shuffle: the seed this ordering was made with.
    seed: int | None = None

    @property
    def has_position(self) -> bool:
        return self.after_id is not None

    @property
    def fetch(self) -> int:
        """Rows to read: one more than the page, to learn whether there is a next."""
        return self.limit + 1


def _encode_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return {"dt": value.isoformat()}
    return value


def _decode_value(value: Any) -> Any:
    if isinstance(value, dict) and set(value) == {"dt"}:
        return datetime.fromisoformat(value["dt"])
    return value


def _pack(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unpack(token: str) -> dict[str, Any]:
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        payload = json.loads(raw)
    except (binascii.Error, ValueError) as exc:
        raise InvalidCursor("Invalid cursor") from exc
    if not isinstance(payload, dict):
        raise InvalidCursor("Invalid cursor")
    return payload


def keyset_cursor(*, sort: str, order: str, value: Any, last_id: int) -> str:
    return _pack(
        {"t": "k", "s": sort, "o": order, "v": _encode_value(value), "i": last_id}
    )


def offset_cursor(
    *, sort: str, order: str, offset: int, seed: int | None = None
) -> str:
    payload: dict[str, Any] = {"t": "o", "s": sort, "o": order, "n": offset}
    if seed is not None:
        payload["r"] = seed
    return _pack(payload)


def parse_cursor(
    token: str | None, *, limit: int, sort: str, order: str
) -> PageRequest:
    """The page a cursor points at (the first page when ``token`` is empty)."""
    if not token:
        return PageRequest(limit=limit)
    payload = _unpack(token)
    if payload.get("s") != sort or payload.get("o") != order:
        raise InvalidCursor("Cursor does not match the requested sort order")
    try:
        if payload.get("t") == "k":
            return PageRequest(
                limit=limit,
                kind="keyset",
                value=_decode_value(payload.get("v")),
                after_id=int(payload["i"]),
            )
        if payload.get("t") == "o":
            seed = payload.get("r")
            return PageRequest(
                limit=limit,
                kind="offset",
                offset=max(0, int(payload["n"])),
                seed=int(seed) if seed is not None else None,
            )
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidCursor("Invalid cursor") from exc
    raise InvalidCursor("Invalid cursor")
