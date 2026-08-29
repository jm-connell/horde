"""AI queue stats must tolerate SQLite naive timestamps."""

from datetime import datetime

from app.models import AiJob, AiJobKind, AiJobStatus
from app.services.ai import worker


def test_queue_stats_compares_naive_run_after(session, monkeypatch):
    monkeypatch.setattr(worker, "get_llm_provider", lambda: None)
    monkeypatch.setattr(worker, "get_embed_provider", lambda: None)
    session.add(
        AiJob(
            kind=AiJobKind.summarize,
            status=AiJobStatus.queued,
            run_after=datetime(2020, 1, 1, 12, 0, 0),
        )
    )
    session.add(
        AiJob(
            kind=AiJobKind.embed_video,
            status=AiJobStatus.queued,
            run_after=datetime(2099, 1, 1, 12, 0, 0),
        )
    )
    session.commit()

    stats = worker.queue_stats()
    assert stats["waiting_count"] == 1
    assert stats["deferred_count"] == 1
