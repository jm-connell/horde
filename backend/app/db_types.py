"""Column types shared by the models."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DateTime
from sqlalchemy.engine import Dialect
from sqlalchemy.types import TypeDecorator


class UtcDateTime(TypeDecorator):
    """A timestamp that is always timezone-aware UTC in Python.

    SQLite has no time zone support: a plain ``DateTime`` column returns naive
    values, so every reader has to remember ``as_utc()`` and a naive/aware
    comparison raises at runtime. This type converts on the way in (aware
    values are normalised to UTC; a naive value is rejected, since it is
    ambiguous) and attaches UTC on the way out.

    The stored text is what ``DateTime`` writes (``YYYY-MM-DD HH:MM:SS.ffffff``
    in UTC), so an existing ``DateTime`` column can be switched to this type
    without a data migration.
    """

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if not isinstance(value, datetime):
            raise TypeError(f"UtcDateTime needs a datetime, got {type(value).__name__}")
        if value.tzinfo is None:
            raise ValueError("UtcDateTime refuses a naive datetime; attach a timezone")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: Any, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        stamped: datetime = value.replace(tzinfo=UTC)
        return stamped
