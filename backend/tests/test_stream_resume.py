"""A streamed (not downloaded) video resumes where the user left it."""

from __future__ import annotations

from typing import Any

import pytest

URL = "https://www.youtube.com/watch?v=resumeme001"


@pytest.fixture(autouse=True)
def info(monkeypatch) -> dict[str, Any]:
    state: dict[str, Any] = {
        "id": "resumeme001",
        "title": "An hour-long stream",
        "duration": 3600.0,
        "webpage_url": URL,
        "formats": [
            {"format_id": "18", "url": "https://rr1.googlevideo.com/v", "height": 360},
        ],
    }
    monkeypatch.setattr(
        "app.services.stream_preview._extract_preview_info",
        lambda url, *, force=False: state,
    )
    return state


def _watch(client, position_sec: float, **extra: Any) -> None:
    resp = client.post(
        "/api/discover/history",
        json={
            "url": URL,
            "position_sec": position_sec,
            "duration_sec": 3600,
            **extra,
        },
    )
    assert resp.status_code == 200, resp.text


def _resume_sec(client) -> float:
    resp = client.get("/api/preview/meta", params={"url": URL})
    assert resp.status_code == 200, resp.text
    return resp.json()["resume_sec"]


def test_a_stream_never_watched_starts_at_the_beginning(client):
    assert _resume_sec(client) == 0


def test_a_stream_resumes_where_it_was_left(client):
    _watch(client, 2640)
    assert _resume_sec(client) == 2640


def test_resume_follows_the_last_position_not_the_furthest(client):
    _watch(client, 2640)
    _watch(client, 600)
    assert _resume_sec(client) == 600


def test_a_finished_stream_starts_over(client):
    _watch(client, 2640)
    _watch(client, 3500)  # past 90%
    assert _resume_sec(client) == 0
    _watch(client, 1200)
    _watch(client, 3600, finished=True)
    assert _resume_sec(client) == 0


def test_resume_is_per_user(client, member_client):
    _watch(client, 2640)
    assert _resume_sec(member_client) == 0
