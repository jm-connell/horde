"""AI chapter jobs: enqueue, skip, LLM snap, processing flag."""

from __future__ import annotations

import json
from pathlib import Path

from app.models import AiJob, AiJobKind, AiJobStatus, VideoAiMeta
from app.services import chapters as chapters_svc
from app.services import library
from app.services.ai import tasks, worker


def _caption(add_video, session, tmp_dirs, *, duration_sec=1200.0, **fields):
    video = add_video(duration_sec=duration_sec, **fields)
    rel = Path(video.file_path).with_suffix(".en.vtt")
    dest = tmp_dirs["downloads"] / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    cues = []
    for i in range(0, int(duration_sec), 20):
        cues.append(
            f"00:{i // 60:02d}:{i % 60:02d}.000 --> "
            f"00:{(i + 10) // 60:02d}:{(i + 10) % 60:02d}.000\n"
            f"Talking about topic {i} with unique details.\n"
        )
    dest.write_text("WEBVTT\n\n" + "\n".join(cues), encoding="utf-8")
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
        "ai_summaries": False,
        "ai_chapters": True,
        "workload_profile": "normal",
    }
    settings.update(overrides)
    return settings


class FakeLlm:
    def __init__(self, replies: list[str]):
        self.replies = list(replies)
        self.calls: list[dict] = []
        self.last_cost = 0.0

    def chat(self, prompt: str, model: str, **kwargs):
        self.calls.append({"prompt": prompt, "model": model, **kwargs})
        if not self.replies:
            return "{  }"
        return self.replies.pop(0)


def test_enqueue_chapters_when_eligible(
    add_video, session, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs)
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker, "enqueue_job", lambda kind, vid, **k: captured.append(kind) or 1
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.chapters in captured


def test_enqueue_skips_chapters_when_too_short(
    add_video, session, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs, duration_sec=120)
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker, "enqueue_job", lambda kind, vid, **k: captured.append(kind) or 1
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.chapters not in captured


def test_enqueue_chapters_when_over_three_minutes(
    add_video, session, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs, duration_sec=200)
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker, "enqueue_job", lambda kind, vid, **k: captured.append(kind) or 1
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.chapters in captured


def test_enqueue_skips_chapters_when_watch_only(
    add_video, session, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs, duration_sec=200)
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker, "enqueue_job", lambda kind, vid, **k: captured.append(kind) or 1
    )
    monkeypatch.setattr(
        worker.app_settings,
        "ai_settings",
        lambda: _ai(ai_chapters_mode="on_watch"),
    )
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.chapters not in captured


def test_enqueue_skips_chapters_when_description_has_them(
    add_video, session, tmp_dirs, monkeypatch
):
    video = _caption(
        add_video,
        session,
        tmp_dirs,
        description="0:00 Intro\n5:00 Main\n",
    )
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker, "enqueue_job", lambda kind, vid, **k: captured.append(kind) or 1
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.chapters not in captured


def test_enqueue_skips_chapters_when_feature_off(
    add_video, session, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs)
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker, "enqueue_job", lambda kind, vid, **k: captured.append(kind) or 1
    )
    monkeypatch.setattr(
        worker.app_settings, "ai_settings", lambda: _ai(ai_chapters=False)
    )
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.chapters not in captured


def test_enqueue_skips_when_already_generated(
    add_video, session, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs)
    session.add(
        VideoAiMeta(
            video_id=video.id,
            chapters=chapters_svc.dump_chapter_list(
                [{"start_sec": 0, "title": "A"}, {"start_sec": 80, "title": "B"}]
            ),
        )
    )
    session.commit()
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker, "enqueue_job", lambda kind, vid, **k: captured.append(kind) or 1
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    monkeypatch.setattr(worker, "openrouter_configured", lambda: False)
    monkeypatch.setattr(worker, "openrouter_owns_embeddings", lambda: False)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.chapters not in captured


def test_dispatch_chapters_skips_without_captions(add_video, session):
    video = add_video(duration_sec=1200)
    reason = tasks.dispatch(session, AiJobKind.chapters, video.id)
    assert reason
    assert "subtitle" in reason.lower() or "caption" in reason.lower()


def test_run_chapters_snaps_llm_output(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs, title="Long talk")
    payload = {
        "chapters": [
            {"start_sec": 2, "title": "Opening remarks"},
            {"start_sec": 400, "title": "Main argument"},
            {"start_sec": 900, "title": "Wrap up"},
        ]
    }
    fake = FakeLlm([json.dumps(payload)])
    monkeypatch.setattr(tasks, "get_llm_provider", lambda: fake)
    monkeypatch.setattr(tasks, "require_llm_chat_model", lambda *a, **k: None)
    monkeypatch.setattr(tasks, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(tasks.app_settings, "ai_settings", lambda: _ai())

    result = tasks.run_chapters(session, video.id, force=True)
    assert len(result) >= 2
    assert result[0]["start_sec"] == 0.0
    assert fake.calls[0]["usage_kind"] == "chapters"
    meta = session.get(VideoAiMeta, video.id)
    assert meta is not None
    stored = chapters_svc.ai_chapters_for(meta)
    assert stored[0]["title"]


def test_run_chapters_retries_empty_then_falls_back(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs)
    fake = FakeLlm(["{  }", "{  }"])
    monkeypatch.setattr(tasks, "get_llm_provider", lambda: fake)
    monkeypatch.setattr(tasks, "require_llm_chat_model", lambda *a, **k: None)
    monkeypatch.setattr(tasks, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(tasks.app_settings, "ai_settings", lambda: _ai())
    result = tasks.run_chapters(session, video.id, force=True)
    assert len(result) >= 2
    assert result[0]["start_sec"] == 0.0
    assert len(fake.calls) == 2
    assert fake.calls[1]["format"] is None


def test_run_chapters_accepts_clock_string_json(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs, duration_sec=480)
    payload = {
        "chapters": [
            {"timestamp": "0:00", "title": "Cold open"},
            {"timestamp": "3:20", "title": "The point"},
        ]
    }
    fake = FakeLlm(["```json\n" + json.dumps(payload) + "\n```"])
    monkeypatch.setattr(tasks, "get_llm_provider", lambda: fake)
    monkeypatch.setattr(tasks, "require_llm_chat_model", lambda *a, **k: None)
    monkeypatch.setattr(tasks, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(tasks.app_settings, "ai_settings", lambda: _ai())
    result = tasks.run_chapters(session, video.id, force=True)
    assert len(result) >= 2
    assert result[0]["start_sec"] == 0.0


def test_get_video_processing_chapters(client, add_video, session):
    video = add_video(duration_sec=1200)
    session.add(
        AiJob(
            kind=AiJobKind.chapters,
            video_id=video.id,
            status=AiJobStatus.queued,
        )
    )
    session.commit()
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["processing_chapters"] is True
    assert body["processing_summary"] is False
    listed = client.get("/api/videos").json()
    row = next(v for v in listed if v["id"] == video.id)
    assert row["processing_chapters"] is False


def test_get_video_description_chapters(client, add_video):
    video = add_video(description="Intro\n0:00 Start\n1:00 Middle\n2:30 End\n")
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["chapters_source"] == "description"
    assert len(body["chapters"]) == 3
    assert body["chapters"][0]["title"] == "Start"
    assert body["chapters"][0]["start_sec"] == 0
