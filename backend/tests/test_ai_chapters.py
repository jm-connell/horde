"""AI chapter jobs: enqueue, skip, model replies, processing flag."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

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
        "base_url": "http://ai.test/v1",
        "chat_model": "chat-model",
        "embed_model": "embed-model",
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


def test_enqueue_chapters_when_eligible(add_video, session, tmp_dirs, monkeypatch):
    video = _caption(add_video, session, tmp_dirs)
    captured: list[AiJobKind] = []
    monkeypatch.setattr(
        worker, "enqueue_job", lambda kind, vid, **k: captured.append(kind) or 1
    )
    monkeypatch.setattr(worker.app_settings, "ai_settings", lambda: _ai())
    monkeypatch.setattr(worker, "llm_configured", lambda: True)
    monkeypatch.setattr(worker, "embeddings_configured", lambda: True)

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
    monkeypatch.setattr(worker, "llm_configured", lambda: True)
    monkeypatch.setattr(worker, "embeddings_configured", lambda: True)

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
    monkeypatch.setattr(worker, "llm_configured", lambda: True)
    monkeypatch.setattr(worker, "embeddings_configured", lambda: True)

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
    monkeypatch.setattr(worker, "llm_configured", lambda: True)
    monkeypatch.setattr(worker, "embeddings_configured", lambda: True)

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
    monkeypatch.setattr(worker, "llm_configured", lambda: True)
    monkeypatch.setattr(worker, "embeddings_configured", lambda: True)

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
    monkeypatch.setattr(worker, "llm_configured", lambda: True)
    monkeypatch.setattr(worker, "embeddings_configured", lambda: True)

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
    monkeypatch.setattr(worker, "llm_configured", lambda: True)
    monkeypatch.setattr(worker, "embeddings_configured", lambda: True)

    worker.enqueue_for_video(video.id, include_tags=False, force=False)
    assert AiJobKind.chapters not in captured


def test_dispatch_chapters_skips_without_captions(add_video, session, monkeypatch):
    monkeypatch.setattr(tasks.app_settings, "ai_settings", lambda: _ai())
    video = add_video(duration_sec=1200)
    reason = tasks.dispatch(session, AiJobKind.chapters, video.id)
    assert reason
    assert "subtitle" in reason.lower() or "caption" in reason.lower()


def _use_llm(monkeypatch, fake, **settings):
    monkeypatch.setattr(tasks, "get_llm_provider", lambda: fake)
    monkeypatch.setattr(tasks, "require_llm_chat_model", lambda *a, **k: None)
    monkeypatch.setattr(tasks, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(tasks.app_settings, "ai_settings", lambda: _ai(**settings))


def _parts(*chapters: tuple[str, str]) -> str:
    """A model reply: the parts list, then one start time per part."""
    return json.dumps(
        {
            "parts": [title for _, title in chapters],
            "chapters": [{"part": title, "start": start} for start, title in chapters],
        }
    )


def test_run_chapters_stores_the_models_parts(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs, title="Long talk")
    fake = FakeLlm(
        [
            _parts(
                ("0:00", "Opening remarks"),
                ("6:40", "Main argument"),
                ("15:00", "Wrap up"),
            )
        ]
    )
    _use_llm(monkeypatch, fake)

    result = tasks.run_chapters(session, video.id, force=True)
    # "6:40" is read as a clock time (400 seconds), not as a number.
    assert result == [
        {"start_sec": 0.0, "title": "Opening remarks"},
        {"start_sec": 400.0, "title": "Main argument"},
        {"start_sec": 900.0, "title": "Wrap up"},
    ]
    call = fake.calls[0]
    assert call["usage_kind"] == "chapters"
    assert call["think"] is False
    assert "[6:40] Talking about topic 400" in call["prompt"]
    meta = session.get(VideoAiMeta, video.id)
    assert meta is not None
    assert chapters_svc.ai_chapters_for(meta) == result


def test_run_chapters_fails_when_the_reply_is_unusable(
    session, add_video, tmp_dirs, monkeypatch
):
    """A reply cut off mid-JSON (the model listed a chapter per caption line and
    ran out of tokens) used to be replaced by evenly spaced markers titled with
    three frequent caption words ("Know Man It's"). Now it is an error."""
    video = _caption(add_video, session, tmp_dirs)
    cut_off = '{"chapters":[{"start_sec":0,"title":"Negotiations"},{"start_sec":119,"ti'
    fake = FakeLlm([cut_off, "```json\n" + cut_off])
    _use_llm(monkeypatch, fake)

    with pytest.raises(tasks.ChaptersError) as raised:
        tasks.run_chapters(session, video.id, force=True)
    assert raised.value.status_code == 502
    assert len(fake.calls) == 2
    assert fake.calls[1]["format"] is None
    meta = session.get(VideoAiMeta, video.id)
    assert meta is None or not chapters_svc.ai_chapters_for(meta)


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
    _use_llm(monkeypatch, fake)
    result = tasks.run_chapters(session, video.id, force=True)
    assert [c["start_sec"] for c in result] == [0.0, 200.0]


def test_run_chapters_reads_a_long_transcript_in_sections(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs, duration_sec=3600)
    fake = FakeLlm(
        [
            _parts(("0:00", "Unboxing the kit"), ("12:00", "Soldering the board")),
            # The second section opens still on the soldering: not a new chapter.
            _parts(("30:00", "Soldering the board"), ("48:00", "First power-on")),
        ]
    )
    _use_llm(monkeypatch, fake)
    monkeypatch.setattr(chapters_svc, "transcript_char_cap", lambda *a, **k: 5000)
    monkeypatch.setattr(chapters_svc, "long_chapters", lambda *a, **k: [])

    result = tasks.run_chapters(session, video.id, force=True)
    assert [(c["start_sec"], c["title"]) for c in result] == [
        (0.0, "Unboxing the kit"),
        (720.0, "Soldering the board"),
        (2880.0, "First power-on"),
    ]
    first, second = (call["prompt"] for call in fake.calls)
    assert "section 1 of 2" in first and "section 2 of 2" in second
    # Every caption line reaches the model once, in one section or the other.
    for i in range(0, 3600, 20):
        line = f"Talking about topic {i} with unique details."
        assert (line in first) != (line in second)
    assert 'the video was on "Soldering the board"' in second


def test_run_chapters_takes_a_second_look_at_a_very_long_chapter(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs, duration_sec=3600)
    fake = FakeLlm(
        [
            # Everything after minute 10 filed under one title: 50 minutes.
            _parts(
                ("0:00", "Bank job"),
                ("5:00", "Getaway"),
                ("10:00", "Rest of the night"),
            ),
            _parts(
                ("10:00", "Hospital run"),
                ("30:00", "Planning the art heist"),
                ("50:00", "Dice game with the cops"),
            ),
        ]
    )
    _use_llm(monkeypatch, fake)

    result = tasks.run_chapters(session, video.id, force=True)
    assert [(c["start_sec"], c["title"]) for c in result] == [
        (0.0, "Bank job"),
        (300.0, "Getaway"),
        (600.0, "Hospital run"),
        (1800.0, "Planning the art heist"),
        (3000.0, "Dice game with the cops"),
    ]
    second = fake.calls[1]["prompt"]
    assert 'one chapter so far, "Rest of the night"' in second
    assert "topic 600 " in second and "topic 580 " not in second


def test_a_long_chapter_on_one_subject_stays_whole(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs, duration_sec=3600)
    fake = FakeLlm(
        [
            _parts(("0:00", "Intro"), ("5:00", "Sponsor"), ("10:00", "The interview")),
            _parts(("10:00", "The interview")),
        ]
    )
    _use_llm(monkeypatch, fake)

    result = tasks.run_chapters(session, video.id, force=True)
    assert [c["title"] for c in result] == ["Intro", "Sponsor", "The interview"]
    assert len(fake.calls) == 2


def test_run_chapters_makes_no_chapters_for_a_video_with_one_part(
    session, add_video, tmp_dirs, monkeypatch
):
    """One part is an answer, not a failure: nothing is stored or made up, and
    the model is not asked a second time."""
    video = _caption(add_video, session, tmp_dirs)
    # The part begins after a silent opening; no "Intro" is invented before it.
    fake = FakeLlm([_parts(("0:40", "Fixing the bike chain"))])
    _use_llm(monkeypatch, fake)

    with pytest.raises(tasks.ChaptersError) as raised:
        tasks.run_chapters(session, video.id, force=False)
    assert raised.value.status_code == 400
    assert raised.value.code == "no_breaks"
    assert "No clear chapter breaks" in str(raised.value)
    assert len(fake.calls) == 1
    session.expire_all()
    meta = session.get(VideoAiMeta, video.id)
    assert not chapters_svc.ai_chapters_for(meta)
    # Nothing is remembered against the video: Generate on Watch asks again.
    assert chapters_svc.skip_reason(video, meta) is None


def test_the_chapter_job_ends_quietly_when_the_video_has_one_part(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs)
    _use_llm(monkeypatch, FakeLlm([_parts(("0:00", "Fixing the bike chain"))]))
    reason = tasks.dispatch(session, AiJobKind.chapters, video.id)
    assert reason == "No clear chapter breaks in this video"


def test_regenerate_that_finds_one_part_removes_the_old_chapters(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs)
    session.add(
        VideoAiMeta(
            video_id=video.id,
            chapters=chapters_svc.dump_chapter_list(
                [
                    {"start_sec": 0, "title": "Intro"},
                    {"start_sec": 400, "title": "Know Man It's"},
                ]
            ),
        )
    )
    session.commit()
    _use_llm(monkeypatch, FakeLlm([_parts(("0:00", "Fixing the bike chain"))]))

    with pytest.raises(tasks.ChaptersError) as raised:
        tasks.run_chapters(session, video.id, force=True)
    assert raised.value.code == "no_breaks"
    session.expire_all()
    assert not chapters_svc.ai_chapters_for(session.get(VideoAiMeta, video.id))


def test_a_failed_regenerate_keeps_the_old_chapters(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _caption(add_video, session, tmp_dirs)
    old = [{"start_sec": 0.0, "title": "Intro"}, {"start_sec": 400.0, "title": "Main"}]
    session.add(
        VideoAiMeta(video_id=video.id, chapters=chapters_svc.dump_chapter_list(old))
    )
    session.commit()
    _use_llm(monkeypatch, FakeLlm(["{  }", "{  }"]))

    with pytest.raises(tasks.ChaptersError) as raised:
        tasks.run_chapters(session, video.id, force=True)
    assert raised.value.status_code == 502
    session.expire_all()
    assert chapters_svc.ai_chapters_for(session.get(VideoAiMeta, video.id)) == old


def test_a_reply_with_no_usable_entry_is_a_failure_not_one_part(
    session, add_video, tmp_dirs, monkeypatch
):
    """Entries the code cannot place (no clock time, a time outside the video)
    are a garbled reply: retried, then an error, never "no chapter breaks"."""
    video = _caption(add_video, session, tmp_dirs)
    garbled = json.dumps(
        {
            "parts": ["Opening", "The climb"],
            "chapters": [
                {"part": "Opening", "start": "at the start"},
                {"part": "The climb", "start": "9:59:00"},
            ],
        }
    )
    fake = FakeLlm([garbled, garbled])
    _use_llm(monkeypatch, fake)

    with pytest.raises(tasks.ChaptersError) as raised:
        tasks.run_chapters(session, video.id, force=True)
    assert raised.value.status_code == 502
    assert raised.value.code is None
    assert len(fake.calls) == 2


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
    listed = client.get("/api/videos").json()["items"]
    row = next(v for v in listed if v["id"] == video.id)
    assert row["processing_chapters"] is False


def test_get_video_description_chapters(client, add_video):
    video = add_video(description="Intro\n0:00 Start\n1:00 Middle\n2:30 End\n")
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["chapters_source"] == "description"
    assert len(body["chapters"]) == 3
    assert body["chapters"][0]["title"] == "Start"
    assert body["chapters"][0]["start_sec"] == 0
