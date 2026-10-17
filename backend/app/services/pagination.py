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
import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

DEFAULT_LIMIT = 100
MAX_LIMIT = 500


def random_key(seed: int, video_id: int) -> int:
    """Where ``video_id`` falls in the shuffle for ``seed``.

    A keyed hash of the id alone: adding or deleting other videos never moves this
    one relative to the rest, which is what lets a shuffle be paged by keyset.
    (Shuffling the id list would reorder everything whenever the set changed.)
    """
    key = (seed % 2**64).to_bytes(8, "big")
    digest = hashlib.blake2b(
        video_id.to_bytes(8, "big", signed=True), digest_size=7, key=key
    )
    return int.from_bytes(digest.digest(), "big")


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


def keyset_cursor(
    *, sort: str, order: str, value: Any, last_id: int, seed: int | None = None
) -> str:
    payload: dict[str, Any] = {
        "t": "k",
        "s": sort,
        "o": order,
        "v": _encode_value(value),
        "i": last_id,
    }
    if seed is not None:
        payload["r"] = seed
    return _pack(payload)


def offset_cursor(
    *, sort: str, order: str, offset: int, seed: int | None = None
) -> str:
    payload: dict[str, Any] = {"t": "o", "s": sort, "o": order, "n": offset}
    if seed is not None:
        payload["r"] = seed
    return _pack(payload)


_INT64 = 2**63
#: Far beyond any library; stops a forged offset from asking for absurd slices.
MAX_OFFSET = 10_000_000
#: Seeds are folded into this range before they reach a cursor.
SEED_RANGE = 2**31

_DATETIME_SORTS = frozenset({"added_at", "published_at", "last_watched_at"})
_NUMBER_SORTS = frozenset({"duration", "file_size", "view_count", "random"})
_TEXT_SORTS = frozenset({"title", "tags"})


def _is_int(value: Any, low: int = -_INT64, high: int = _INT64) -> bool:
    return (
        isinstance(value, int) and not isinstance(value, bool) and low <= value < high
    )


def _check_sort_value(sort: str, value: Any) -> Any:
    """``value`` as the type the sort column holds, or ``InvalidCursor``."""
    if value is None and sort != "random":
        return None
    if sort in _NUMBER_SORTS:
        ok = _is_int(value) or (
            isinstance(value, float) and math.isfinite(value) and abs(value) < _INT64
        )
        if not ok:
            raise InvalidCursor("Invalid cursor")
        return value
    if sort in _TEXT_SORTS:
        if not isinstance(value, str):
            raise InvalidCursor("Invalid cursor")
        return value
    # Everything else sorts on a timestamp (unknown sort keys fall back to added_at).
    decoded = _decode_value(value)
    # The columns store aware timestamps; a naive one fails at bind time.
    if not isinstance(decoded, datetime) or decoded.tzinfo is None:
        raise InvalidCursor("Invalid cursor")
    return decoded


def parse_cursor(
    token: str | None,
    *,
    limit: int,
    sort: str,
    order: str,
    kind: Literal["keyset", "offset"] = "keyset",
) -> PageRequest:
    """The page a cursor points at (the first page when ``token`` is empty).

    ``kind`` is what this request can use: a cursor of the other kind, or one whose
    contents do not fit the sort column, is refused with ``InvalidCursor``.
    """
    if not token:
        return PageRequest(limit=limit, kind=kind)
    payload = _unpack(token)
    if payload.get("s") != sort or payload.get("o") != order:
        raise InvalidCursor("Cursor does not match the requested sort order")
    marker = payload.get("t")
    if marker != ("k" if kind == "keyset" else "o"):
        raise InvalidCursor("Cursor does not match this kind of listing")
    try:
        if kind == "keyset":
            after_id = payload["i"]
            seed = payload.get("r")
            if not _is_int(after_id) or (
                seed is not None and not _is_int(seed, 0, SEED_RANGE)
            ):
                raise InvalidCursor("Invalid cursor")
            return PageRequest(
                limit=limit,
                kind="keyset",
                value=_check_sort_value(sort, payload.get("v")),
                after_id=after_id,
                seed=seed,
            )
        offset = payload["n"]
        seed = payload.get("r")
        if not _is_int(offset, 0, MAX_OFFSET + 1):
            raise InvalidCursor("Invalid cursor")
        if seed is not None and not _is_int(seed, 0, SEED_RANGE):
            raise InvalidCursor("Invalid cursor")
        return PageRequest(limit=limit, kind="offset", offset=offset, seed=seed)
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise InvalidCursor("Invalid cursor") from exc
