"""OpenRouter cost ledger windows must tolerate SQLite naive timestamps."""

from datetime import datetime, timezone

from app.models import OpenRouterUsage
from app.services.ai import cost_ledger


def test_totals_compares_naive_and_aware_created_at(session):
    session.add(
        OpenRouterUsage(
            kind="summary",
            cost=0.01,
            created_at=datetime(2020, 1, 1, 12, 0, 0),
        )
    )
    session.add(
        OpenRouterUsage(
            kind="chat",
            cost=0.02,
            created_at=datetime.now(timezone.utc),
        )
    )
    session.commit()

    data = cost_ledger.totals()
    assert data["all"] == 0.03
    assert data["h24"] == 0.02
    assert data["y1"] == 0.02
