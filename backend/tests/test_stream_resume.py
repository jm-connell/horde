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


def _continue_ids(client) -> list[str]:
    resp = client.get("/api/history/continue-streams")
    assert resp.status_code == 200, resp.text
    return [i["id"] for i in resp.json()["items"]]


def test_a_part_watched_stream_joins_continue_watching(client, member_client):
    _watch(client, 20)  # only opened
    assert _continue_ids(client) == []
    _watch(client, 2640, title="An hour-long stream", channel="Chan")
    body = client.get("/api/history/continue-streams").json()
    assert body["items"] == [
        {
            **body["items"][0],
            "id": "resumeme001",
            "url": URL,
            "title": "An hour-long stream",
            "channel": "Chan",
            "duration": 3600.0,
            "position_sec": 2640.0,
        }
    ]
    assert _continue_ids(member_client) == []
    _watch(client, 3500)  # finished
    assert _continue_ids(client) == []


def test_a_downloaded_or_old_stream_leaves_continue_watching(
    client, session, admin_user, add_video
):
    from datetime import UTC, datetime, timedelta

    from app.models import UserStreamState

    _watch(client, 2640)
    row = session.get(UserStreamState, (admin_user.id, "resumeme001"))
    row.last_watched_at = datetime.now(UTC) - timedelta(days=60)
    session.add(row)
    session.commit()
    assert _continue_ids(client) == []

    _watch(client, 2640)
    assert _continue_ids(client) == ["resumeme001"]
    add_video(title="Downloaded since", yt_id="resumeme001")
    assert _continue_ids(client) == []
