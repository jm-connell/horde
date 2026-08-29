"""Auto-enqueue summarize on download (after captions exist)."""

from __future__ import annotations

from pathlib import Path

from app.models import AiJob, AiJobKind, AiJobStatus, VideoAiMeta
from app.services import library
from app.services.ai import tasks, worker


def _caption(add_video, session, tmp_dirs, **fields):
    video = add_video(**fields)
    rel = Path(video.file_path).with_suffix(".en.vtt")
    dest = tmp_dirs["downloads"] / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n"
        "Riders climb a ridge at dawn and talk through gear and weather.\n",
        encoding="utf-8",
    )
    video.subtitles = library.dump_subtitles(
        [{"lang": "en", "path": rel.as_posix(), "auto": False}]
    )
    session.add(video)
    session.commit()
    session.refresh(video)
    return video


def _ai(**overrides):
    settings = {
        "paused": False,
        "enabled": True,
        "schedule": "on_download",
        "enrich_tags": False,
        "ai_summaries": True,
    }
    settings.update(overrides)
    return settings


def test_enqueue_summarize_when_captions_exist(
    add_video, session, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs)
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker,
        "enqueue_job",
        lambda kind, vid, **k: captured.append(kind) or 1,
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.summarize in captured


def test_enqueue_skips_summarize_without_captions(add_video, monkeypatch):
    video = add_video()
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker,
        "enqueue_job",
        lambda kind, vid, **k: captured.append(kind) or 1,
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.summarize not in captured


def test_enqueue_skips_summarize_when_already_present(
    add_video, session, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs)
    session.add(VideoAiMeta(video_id=video.id, summary="Already written."))
    session.commit()
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker,
        "enqueue_job",
        lambda kind, vid, **k: captured.append(kind) or 1,
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.summarize not in captured


def test_enqueue_skips_summarize_when_feature_off(
    add_video, session, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs)
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker,
        "enqueue_job",
        lambda kind, vid, **k: captured.append(kind) or 1,
    )
    monkeypatch.setattr(
        worker.app_settings, "ai_settings", lambda: _ai(ai_summaries=False)
    )
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.summarize not in captured


def test_dispatch_summarize_skips_without_captions(add_video, session):
    video = add_video()
    reason = tasks.dispatch(session, AiJobKind.summarize, video.id)
    assert reason
    assert "subtitle" in reason.lower() or "caption" in reason.lower()


def test_get_video_processing_summary(client, add_video, session):
    video = add_video()
    session.add(
        AiJob(
            kind=AiJobKind.summarize,
            video_id=video.id,
            status=AiJobStatus.queued,
        )
    )
    session.commit()
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["processing_summary"] is True
    assert body["processing_sprites"] is False
    listed = client.get("/api/videos").json()
    row = next(v for v in listed if v["id"] == video.id)
    assert row["processing_summary"] is False
