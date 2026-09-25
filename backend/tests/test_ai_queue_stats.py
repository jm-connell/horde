"""AI queue stats must tolerate SQLite naive timestamps."""

from app.models import AiJob, AiJobKind, AiJobStatus
from app.services.ai import worker


def _store_naive_run_after(session, job_id: int, stamp: str) -> None:
    session.connection().exec_driver_sql(
        "UPDATE ai_jobs SET run_after = ? WHERE id = ?",
        (stamp, job_id),
    )


def test_queue_stats_compares_naive_run_after(session, monkeypatch):
    monkeypatch.setattr(worker, "get_llm_provider", lambda: None)
    monkeypatch.setattr(worker, "get_embed_provider", lambda: None)
    due = AiJob(kind=AiJobKind.summarize, status=AiJobStatus.queued)
    deferred = AiJob(kind=AiJobKind.embed_video, status=AiJobStatus.queued)
    session.add(due)
    session.add(deferred)
    session.commit()
    _store_naive_run_after(session, due.id, "2020-01-01 12:00:00")
    _store_naive_run_after(session, deferred.id, "2099-01-01 12:00:00")
    session.commit()

    stats = worker.queue_stats()
    assert stats["waiting_count"] == 1
    assert stats["deferred_count"] == 1
