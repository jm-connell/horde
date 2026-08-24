"""Summary extraction and empty-JSON retry (Gemini/Qwen json_object `{  }`)."""

from __future__ import annotations

import json
from pathlib import Path

from app.services import library
from app.services.ai import tasks
from app.services.ai.provider import (
    assistant_message_text,
    is_empty_json_payload,
    openrouter_response_format,
)
from app.services.ai.text import SUMMARY_JSON_SCHEMA


def _captioned_video(add_video, session, tmp_dirs, **fields):
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


def _words(n: int = 90) -> str:
    return " ".join(["Riders climb the ridge at dawn."] * n)


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


def test_extract_summary_empty_json_object():
    assert tasks._extract_summary_text("{  }") == ""
    assert tasks._extract_summary_text("{}") == ""


def test_extract_summary_capitalized_key():
    assert tasks._extract_summary_text('{"Summary": "Hello there."}') == "Hello there."


def test_extract_summary_prose():
    text = "The crew rebuilds a trail bike and tests it on loose gravel."
    assert tasks._extract_summary_text(text) == text


def test_is_empty_json_payload():
    assert is_empty_json_payload("{  }")
    assert is_empty_json_payload("{}")
    assert not is_empty_json_payload('{"summary": "ok"}')
    assert not is_empty_json_payload("plain text")


def test_assistant_message_text_uses_reasoning_when_content_empty():
    summary = "A long ride through the hills covering gear and weather."
    text = assistant_message_text(
        {
            "content": "{  }",
            "reasoning": json.dumps({"summary": summary}),
        }
    )
    assert summary in text


def test_assistant_message_text_prefers_real_content():
    text = assistant_message_text(
        {
            "content": '{"summary": "Visible summary."}',
            "thinking": "internal draft that should be ignored",
        }
    )
    assert "Visible summary" in text
    assert "internal draft" not in text


def test_openrouter_response_format_schema():
    body = openrouter_response_format(SUMMARY_JSON_SCHEMA)
    assert body is not None
    assert body["type"] == "json_schema"
    assert body["json_schema"]["schema"]["required"] == ["summary"]
    assert openrouter_response_format("json") == {"type": "json_object"}
    assert openrouter_response_format(None) is None


def test_summarize_retries_without_json_after_empty_object(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _captioned_video(add_video, session, tmp_dirs, title="Ridge ride")
    summary = _words(20)
    fake = FakeLlm(["{  }", json.dumps({"summary": summary})])
    monkeypatch.setattr(tasks, "get_llm_provider", lambda: fake)
    monkeypatch.setattr(tasks, "require_llm_chat_model", lambda *a, **k: None)
    monkeypatch.setattr(tasks, "llm_features_allowed", lambda: (True, None))

    result = tasks.run_summarize(session, video.id, force=True)
    assert "Riders climb" in result
    assert len(fake.calls) >= 2
    assert fake.calls[0]["format"] == SUMMARY_JSON_SCHEMA
    assert fake.calls[1]["format"] is None


def test_summarize_still_fails_when_both_attempts_empty(
    session, add_video, tmp_dirs, monkeypatch
):
    video = _captioned_video(add_video, session, tmp_dirs, title="Ridge ride")
    fake = FakeLlm(["{  }", "{  }"])
    monkeypatch.setattr(tasks, "get_llm_provider", lambda: fake)
    monkeypatch.setattr(tasks, "require_llm_chat_model", lambda *a, **k: None)
    monkeypatch.setattr(tasks, "llm_features_allowed", lambda: (True, None))

    try:
        tasks.run_summarize(session, video.id, force=True)
        raise AssertionError("expected SummarizeError")
    except tasks.SummarizeError as exc:
        assert exc.status_code == 502
        assert "empty summary" in str(exc).lower()
