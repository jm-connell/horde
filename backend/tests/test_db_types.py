from datetime import UTC, datetime, timedelta, timezone

import pytest
from sqlalchemy import Column, MetaData, Table, create_engine, select

from app.db_types import UtcDateTime

_TABLE = Table("t", MetaData(), Column("at", UtcDateTime))


def _roundtrip(value):
    engine = create_engine("sqlite://")
    _TABLE.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(_TABLE.insert().values(at=value))
        return conn.execute(select(_TABLE.c.at)).scalar_one(), conn.exec_driver_sql(
            "SELECT at FROM t"
        ).scalar_one()


def test_aware_values_come_back_as_utc():
    plus_two = timezone(timedelta(hours=2))
    got, raw = _roundtrip(datetime(2026, 1, 1, 12, 0, tzinfo=plus_two))
    assert got == datetime(2026, 1, 1, 10, 0, tzinfo=UTC)
    assert got.tzinfo is UTC
    # Same stored text a plain DateTime column would hold.
    assert raw.startswith("2026-01-01 10:00:00")


def test_none_roundtrips():
    assert _roundtrip(None)[0] is None


def test_naive_values_are_rejected():
    with pytest.raises(Exception, match="naive"):
        _roundtrip(datetime(2026, 1, 1))
