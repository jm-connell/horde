"""Catch-up enqueue must tolerate SQLite naive timestamps."""

from datetime import datetime, timedelta, timezone

from sqlmodel import select

from app.models import AiJob, AiJobKind, AiJobStatus, VideoAiMeta, utcnow
from app.services.ai import embeddings, text as ai_text, worker


def _ai(**overrides):
    settings = {
        "paused": False,
        "enabled": True,
        "schedule": "on_download",
        "enrich_tags": True,
        "ai_summaries": False,
        "tag_rescan_days": 90,
    }
    settings.update(overrides)
    return settings


def test_enqueue_all_recent_compares_naive_tags_enriched_at(
    add_video, session, monkeypatch
):
    video = add_video(added_at=utcnow() - timedelta(days=1))
    session.add(
        VideoAiMeta(
            video_id=video.id,
            tags_enriched_at=datetime(2020, 1, 1, 12, 0, 0),
        )
    )
    session.commit()

    captured: list[tuple] = []
    monkeypatch.setattr(
        worker,
        "enqueue_job",
        lambda kind, vid, **k: captured.append((kind, vid)) or 1,
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    monkeypatch.setattr(worker.embeddings, "videos_needing_embed", lambda *a, **k: [])

    result = worker.enqueue_all_recent()
    assert result["breakdown"]["tags"] == 1
    assert any(vid == video.id for _, vid in captured)


def test_enqueue_missing_tags_compares_naive_tags_enriched_at(
    add_video, session, monkeypatch
):
    video = add_video()
    session.add(
        VideoAiMeta(
            video_id=video.id,
            tags_enriched_at=datetime(2020, 1, 1, 12, 0, 0),
            updated_at=datetime.now(timezone.utc),
        )
    )
    session.commit()

    captured: list[tuple] = []
    monkeypatch.setattr(
        worker,
        "enqueue_job",
        lambda kind, vid, **k: captured.append((kind, vid)) or 1,
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())

    result = worker.enqueue_missing_tags()
    assert result["breakdown"]["tags"] == 1
    assert any(vid == video.id for _, vid in captured)


def test_maybe_enqueue_index_catchup_on_download(monkeypatch):
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    captured: list[dict] = []
    monkeypatch.setattr(
        worker,
        "enqueue_missing_embeds",
        lambda **kwargs: captured.append(kwargs)
        or {
            "enqueued": 1,
            "breakdown": {"embed": 1, "tags": 0, "categories": 0},
            "detail": "1 embed",
        },
    )
    result = worker.maybe_enqueue_index_catchup()
    assert captured == [{"skip_failed": True, "skip_empty_document": True}]
    assert result["enqueued"] == 1


def test_maybe_enqueue_index_catchup_skips_on_request(monkeypatch):
    monkeypatch.setattr(
        worker.app_settings, "ai_settings", lambda: _ai(schedule="on_request")
    )
    captured: list[dict] = []
    monkeypatch.setattr(
        worker,
        "enqueue_missing_embeds",
        lambda **kwargs: captured.append(kwargs)
        or {
            "enqueued": 1,
            "breakdown": {"embed": 1, "tags": 0, "categories": 0},
            "detail": "1 embed",
        },
    )
    result = worker.maybe_enqueue_index_catchup()
    assert captured == []
    assert result["enqueued"] == 0


def test_maybe_enqueue_index_catchup_respects_pause(monkeypatch):
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai(paused=True))
    captured: list[dict] = []
    monkeypatch.setattr(
        worker,
        "enqueue_missing_embeds",
        lambda **kwargs: captured.append(kwargs)
        or {
            "enqueued": 1,
            "breakdown": {"embed": 1, "tags": 0, "categories": 0},
            "detail": "1 embed",
        },
    )
    result = worker.maybe_enqueue_index_catchup()
    assert captured == []
    assert result["enqueued"] == 0


def test_enqueue_missing_embeds_skip_failed(add_video, session, monkeypatch):
    video = add_video()
    session.add(
        AiJob(
            kind=AiJobKind.embed_video,
            video_id=video.id,
            status=AiJobStatus.error,
            error="boom",
        )
    )
    session.commit()
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())

    skipped = worker.enqueue_missing_embeds(skip_failed=True)
    assert skipped["breakdown"]["embed"] == 0

    retried = worker.enqueue_missing_embeds()
    assert retried["breakdown"]["embed"] == 1
    queued = session.exec(
        select(AiJob).where(
            AiJob.video_id == video.id,
            AiJob.kind == AiJobKind.embed_video,
            AiJob.status == AiJobStatus.queued,
        )
    ).all()
    assert queued


def test_videos_needing_embed_skips_empty_document(add_video, session):
    video = add_video()
    digest = ai_text.content_hash(video, use_subtitles=True)
    session.add(
        VideoAiMeta(
            video_id=video.id,
            embed_status="error",
            embed_error="empty_document",
            content_hash=digest,
        )
    )
    session.commit()

    skipped = embeddings.videos_needing_embed(session, skip_empty_document=True)
    assert video.id not in skipped
    included = embeddings.videos_needing_embed(session)
    assert video.id in included
