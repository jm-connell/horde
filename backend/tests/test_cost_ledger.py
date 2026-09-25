"""OpenRouter cost ledger windows must tolerate SQLite naive timestamps."""

from app.models import OpenRouterUsage
from app.services.ai import cost_ledger


def test_totals_compares_naive_and_aware_created_at(session):
    old = OpenRouterUsage(kind="summary", cost=0.01)
    recent = OpenRouterUsage(kind="chat", cost=0.02)
    session.add(old)
    session.add(recent)
    session.commit()
    # Older libraries stored this column without an offset.
    session.connection().exec_driver_sql(
        "UPDATE openrouter_usage SET created_at = ? WHERE id = ?",
        ("2020-01-01 12:00:00", old.id),
    )
    session.commit()

    data = cost_ledger.totals()
    assert data["all"] == 0.03
    assert data["h24"] == 0.02
    assert data["y1"] == 0.02

    stats = cost_ledger.window_analytics()
    assert stats["all"]["calls"] == 2
    assert stats["h24"]["calls"] == 1
    assert stats["h24"]["cost"] == 0.02


def test_record_cost_swallows_database_locked(init_db, monkeypatch):
    import sqlite3

    from sqlalchemy.exc import OperationalError

    class LockedSession:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def add(self, _row):
            return None

        def commit(self):
            raise OperationalError(
                "INSERT",
                {},
                sqlite3.OperationalError("database is locked"),
            )

    monkeypatch.setattr(cost_ledger, "Session", LockedSession)
    assert cost_ledger.record_cost(cost=0.01, kind="embed", model="x") == 0.01
