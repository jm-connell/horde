"""/api/system/update: the "Update now" button's request and status files."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.context import get_paths
from app.services import update_control


def _dir():
    return update_control.control_dir(get_paths().data)


def _check_in(minutes_ago: float = 0) -> None:
    _dir().mkdir(parents=True, exist_ok=True)
    seen = datetime.now(UTC) - timedelta(minutes=minutes_ago)
    (_dir() / "watcher.env").write_text(
        f"LAST_SEEN={seen.strftime('%Y-%m-%dT%H:%M:%SZ')}\n"
    )


def test_not_set_up_until_the_watcher_checks_in(client):
    body = client.get("/api/system/update").json()
    assert body["watcher_connected"] is False
    assert body["state"] == "idle"

    refused = client.post("/api/system/update")
    assert refused.status_code == 409
    assert refused.json()["code"] == "update_watcher_missing"
    assert not (_dir() / "request.env").exists()

    _check_in(minutes_ago=30)  # cron stopped long ago
    assert client.get("/api/system/update").json()["watcher_connected"] is False


def test_request_then_cancel(client):
    _check_in()

    started = client.post("/api/system/update")
    assert started.status_code == 200, started.text
    body = started.json()
    assert body["state"] == "requested"
    assert body["requested_by"] == "admin"
    assert len(body["request_id"]) == 32
    text = (_dir() / "request.env").read_text()
    assert f"REQUEST_ID={body['request_id']}" in text

    again = client.post("/api/system/update")
    assert again.status_code == 409
    assert again.json()["code"] == "update_in_progress"

    cancelled = client.post("/api/system/update/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["state"] == "idle"
    nothing = client.post("/api/system/update/cancel")
    assert nothing.status_code == 409
    assert nothing.json()["code"] == "update_not_pending"


def test_running_update_reports_progress_and_blocks_a_second_request(client):
    _check_in()
    rid = "b" * 32
    (_dir() / "current.env").write_text(
        f"REQUEST_ID={rid}\nREQUESTED_AT=2026-10-17T10:00:00Z\nREQUESTED_BY=admin\n"
    )
    (_dir() / "status.env").write_text(
        f"STATE=running\nREQUEST_ID={rid}\nSTARTED_AT=2026-10-17T10:00:30Z\n"
    )
    (_dir() / "update.log").write_text("Building horde image\n")

    body = client.get("/api/system/update").json()
    assert body["state"] == "running"
    assert body["requested_by"] == "admin"
    assert body["log_tail"] == ["Building horde image"]
    assert client.post("/api/system/update").json()["code"] == "update_in_progress"

    # The watcher stopped checking in mid-run (host rebooted): not "running" forever.
    _check_in(minutes_ago=30)
    assert client.get("/api/system/update").json()["state"] == "interrupted"


def test_finished_states_and_unknown_values(client):
    _check_in()
    (_dir() / "status.env").write_text(
        "STATE=rolled_back\nREQUEST_ID=" + "c" * 32 + "\nEXIT_CODE=1\n"
    )
    body = client.get("/api/system/update").json()
    assert body["state"] == "rolled_back"
    assert body["exit_code"] == 1
    assert body["requested_by"] is None  # current.env belongs to another request

    (_dir() / "status.env").write_text("STATE=garbage\n")
    assert client.get("/api/system/update").json()["state"] == "failed"

    # A finished update does not block the next one.
    assert client.post("/api/system/update").status_code == 200


def test_log_tail_is_bounded(client):
    _check_in()
    (_dir() / "status.env").write_text("STATE=updated\n")
    (_dir() / "update.log").write_text("".join(f"line {i}\n" for i in range(5000)))

    tail = client.get("/api/system/update").json()["log_tail"]
    assert len(tail) == update_control.LOG_TAIL_LINES
    assert tail[-1] == "line 4999"


def test_members_cannot_see_or_start_updates(member_client):
    _check_in()
    assert member_client.get("/api/system/update").status_code == 403
    assert member_client.post("/api/system/update").status_code == 403
    assert not (_dir() / "request.env").exists()


def test_a_request_the_watcher_has_taken_counts_as_running(client):
    """Between moving request.env to current.env and writing status.env."""
    _check_in()
    old, new = "c" * 32, "d" * 32
    (_dir() / "status.env").write_text(f"STATE=updated\nREQUEST_ID={old}\n")
    (_dir() / "current.env").write_text(f"REQUEST_ID={new}\nREQUESTED_BY=admin\n")

    body = client.get("/api/system/update").json()
    assert body["state"] == "running"
    assert body["request_id"] == new
    assert client.post("/api/system/update").json()["code"] == "update_in_progress"

    _check_in(minutes_ago=30)
    assert client.get("/api/system/update").json()["state"] == "interrupted"


def test_unwritable_update_folder_is_a_coded_error(client, monkeypatch):
    _check_in()

    def refuse(*_args, **_kwargs):
        raise PermissionError("read-only")

    monkeypatch.setattr(update_control.os, "replace", refuse)
    resp = client.post("/api/system/update")
    assert resp.status_code == 500
    assert resp.json()["code"] == "update_request_failed"
    assert not (_dir() / "request.env").exists()
    assert not list(_dir().glob(".request.*"))
