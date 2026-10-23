"""Notifications: targets in the settings, delivery to ntfy / webhook / Discord, and the hooks."""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from sqlmodel import Session
from ytdlp_fakes import FakeYtdlp, make_info, run_job_inline, stub_media_probes

from app import config
from app.models import DownloadJob, JobOrigin, JobStatus
from app.services import app_settings, notifications
from app.services.notifications import events, targets, watchers
from app.services.notifications.delivery import DeliveryError, build_request
from app.services.notifications.notifier import Notifier
from app.services.notifications.render import Message, render, sample

URL = "https://www.youtube.com/watch?v=notify00001"

# -- helpers ---------------------------------------------------------------------


class Stub:
    """A local HTTP server that records what it is sent and answers a set status."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.status = 200
        self.headers: dict[str, str] = {}
        self.base = ""


@pytest.fixture
def stub():
    state = Stub()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            state.requests.append(
                {
                    "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": self.rfile.read(length),
                }
            )
            self.send_response(state.status)
            for key, value in state.headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state.base = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield state
    server.shutdown()
    server.server_close()
    thread.join(5)


def _add_target(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "name": "Phone",
        "kind": "ntfy",
        "url": "https://ntfy.example",
        "topic": "horde",
    }
    fields.update(over)
    return targets.create_target(fields)


class Recorder:
    """A sender that remembers what it was asked to deliver."""

    def __init__(self, failures: list[DeliveryError] | None = None) -> None:
        self.sent: list[tuple[dict[str, Any], Message]] = []
        self.failures = list(failures or [])

    def __call__(self, target: dict[str, Any], message: Message) -> int:
        self.sent.append((target, message))
        if self.failures:
            raise self.failures.pop(0)
        return 200

    @property
    def titles(self) -> list[str]:
        return [m.title for _t, m in self.sent]


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def notifier(init_db) -> Callable[..., tuple[Notifier, Recorder, Clock]]:
    """Install a notifier with a recording sender and a manual clock on the context."""

    def make(**kw: Any) -> tuple[Notifier, Recorder, Clock]:
        recorder = Recorder(kw.pop("failures", None))
        clock = Clock()
        n = Notifier(sender=recorder, clock=clock, backoff=(0.0, 0.0), **kw)
        init_db["ctx"].notifier = n
        return n, recorder, clock

    return make


# -- the event registry --------------------------------------------------------------


def test_every_event_has_wording():
    for spec in events.EVENTS:
        message = render(spec.name, [{"title": "T", "channel": "C", "reason": "R"}])
        assert message.title and message.body and message.event == spec.name


def test_defaults_are_the_documented_ones():
    assert events.default_events() == [
        "download_failed",
        "queue_held",
        "update_failed",
    ]
    assert events.default_options() == {"only_automatic": True}


# -- the API -------------------------------------------------------------------------


def test_the_list_carries_the_event_registry(client):
    body = client.get("/api/notifications").json()
    assert body["targets"] == []
    assert body["max_targets"] == 10
    assert body["public_url_set"] is False
    names = [e["name"] for e in body["events"]]
    assert names == [spec.name for spec in events.EVENTS]
    completed = next(e for e in body["events"] if e["name"] == "download_completed")
    assert completed["options"][0]["key"] == "only_automatic"
    assert completed["options"][0]["default"] is True
    assert completed["label"] and completed["description"]


def test_a_new_target_gets_the_default_events_and_hides_its_token(client):
    resp = client.post(
        "/api/notifications/targets",
        json={
            "name": "Phone",
            "kind": "ntfy",
            "url": "https://ntfy.example",
            "topic": "horde",
            "token": "tk_secret1234",
        },
    )
    assert resp.status_code == 200, resp.text
    made = resp.json()
    assert made["events"] == ["download_failed", "queue_held", "update_failed"]
    assert made["options"] == {"only_automatic": True}
    assert made["enabled"] is True
    assert made["token"] == "••••1234" and made["token_set"] is True
    assert "tk_secret1234" not in resp.text

    listing = client.get("/api/notifications")
    assert "tk_secret1234" not in listing.text
    assert listing.json()["targets"] == [made]
    # The server-wide settings the whole UI reads never carry it either.
    assert "tk_secret1234" not in client.get("/api/settings").text
    # It is stored, so deliveries can use it.
    assert targets.get_target(made["id"])["token"] == "tk_secret1234"  # type: ignore[index]


def test_editing_keeps_the_token_unless_told_otherwise(client):
    made = client.post(
        "/api/notifications/targets",
        json={
            "name": "Hook",
            "kind": "webhook",
            "url": "https://hooks.example/x",
            "token": "bearer-abcd",
        },
    ).json()
    url = f"/api/notifications/targets/{made['id']}"

    renamed = client.patch(url, json={"name": "Renamed"}).json()
    assert renamed["name"] == "Renamed" and renamed["token"] == "••••abcd"
    client.patch(url, json={"token": "••••abcd"})  # the form sends the mask back
    assert targets.get_target(made["id"])["token"] == "bearer-abcd"  # type: ignore[index]

    client.patch(url, json={"token": "new-token-9999"})
    assert targets.get_target(made["id"])["token"] == "new-token-9999"  # type: ignore[index]

    cleared = client.patch(url, json={"token": ""}).json()
    assert cleared["token_set"] is False and cleared["token"] == ""


def test_a_patch_changes_only_what_it_names(client):
    made = client.post(
        "/api/notifications/targets",
        json={
            "name": "A",
            "kind": "ntfy",
            "url": "https://ntfy.example",
            "topic": "t1",
            "events": ["download_completed"],
            "options": {"only_automatic": False},
        },
    ).json()
    url = f"/api/notifications/targets/{made['id']}"
    off = client.patch(url, json={"enabled": False}).json()
    assert off["enabled"] is False
    assert off["events"] == ["download_completed"]
    assert off["options"] == {"only_automatic": False}
    assert off["topic"] == "t1"

    moved = client.patch(
        url, json={"kind": "discord", "url": "https://discord.example/api/webhooks/1/x"}
    ).json()
    assert moved["kind"] == "discord" and moved["topic"] is None


def test_delete_and_unknown_ids(client):
    made = client.post(
        "/api/notifications/targets",
        json={"name": "A", "kind": "discord", "url": "https://d.example/hook"},
    ).json()
    assert client.delete(f"/api/notifications/targets/{made['id']}").json() == {
        "ok": True
    }
    assert client.get("/api/notifications").json()["targets"] == []
    for call in (
        client.delete("/api/notifications/targets/nope"),
        client.patch("/api/notifications/targets/nope", json={"name": "x"}),
        client.post("/api/notifications/targets/nope/test"),
    ):
        assert call.status_code == 404
        assert call.json()["code"] in (
            "notification_target_not_found",
            "not_found",
        )


@pytest.mark.parametrize(
    "fields",
    [
        {"url": "ftp://ntfy.example"},
        {"url": "not a url"},
        {"url": "https://user:pass@ntfy.example"},
        {"url": ""},
        {"topic": ""},
        {"topic": "has space"},
        {"topic": "a/b"},
        {"name": "  "},
        {"token": "has space"},
        {"events": ["download_failed", "nonsense"]},
        {"options": {"nonsense": True}},
    ],
)
def test_invalid_targets_are_refused(client, fields):
    body = {
        "name": "A",
        "kind": "ntfy",
        "url": "https://ntfy.example",
        "topic": "t",
        **fields,
    }
    resp = client.post("/api/notifications/targets", json=body)
    assert resp.status_code == 422, resp.text
    assert client.get("/api/notifications").json()["targets"] == []


def test_no_more_than_ten_targets(client):
    body = {"name": "A", "kind": "discord", "url": "https://d.example/hook"}
    for _ in range(10):
        assert client.post("/api/notifications/targets", json=body).status_code == 200
    resp = client.post("/api/notifications/targets", json=body)
    assert resp.status_code == 409
    assert resp.json()["code"] == "notification_limit"


def test_only_administrators_manage_notifications(member_client, anon_client):
    for c in (member_client, anon_client):
        assert c.get("/api/notifications").status_code in (401, 403)
        assert c.post(
            "/api/notifications/targets",
            json={"name": "A", "kind": "discord", "url": "https://d.example/h"},
        ).status_code in (401, 403)
        assert c.post("/api/notifications/test", json={}).status_code in (401, 403)


# -- the test button: exactly what is sent ---------------------------------------------


def test_ntfy_gets_the_message_as_the_body_and_the_rest_as_headers(client, stub):
    made = client.post(
        "/api/notifications/targets",
        json={
            "name": "Phone",
            "kind": "ntfy",
            "url": stub.base + "/",
            "topic": "my-horde",
            "token": "tk_abc",
        },
    ).json()
    resp = client.post(f"/api/notifications/targets/{made['id']}/test")
    assert resp.json() == {"ok": True, "status_code": 200, "error": None}

    (req,) = stub.requests
    assert req["path"] == "/my-horde"
    assert req["body"] == b"If you can read this, this target works."
    assert req["headers"]["title"] == "Horde test notification"
    assert req["headers"]["priority"] == "default"
    assert req["headers"]["tags"] == "bell,horde"
    assert req["headers"]["authorization"] == "Bearer tk_abc"
    assert "click" not in req["headers"]  # no public address configured


def test_ntfy_links_back_when_the_public_address_is_known(client, stub, monkeypatch):
    monkeypatch.setattr(config, "PUBLIC_URL", "https://horde.example")
    resp = client.post(
        "/api/notifications/test",
        json={"name": "P", "kind": "ntfy", "url": stub.base, "topic": "t"},
    )
    assert resp.json()["ok"] is True
    assert (
        stub.requests[0]["headers"]["click"]
        == "https://horde.example/settings?tab=system"
    )
    assert "authorization" not in stub.requests[0]["headers"]


def test_ntfy_titles_with_accents_travel_as_an_encoded_word():
    message = Message("download_failed", "Tést — ünï", "body", urgent=True)
    request = build_request(
        {"kind": "ntfy", "url": "https://ntfy.example", "topic": "t", "token": ""},
        message,
    )
    assert request.headers["Title"] == "=?UTF-8?B?VMOpc3Qg4oCUIMO8bsOv?="
    assert request.headers["Priority"] == "high"


def test_a_webhook_gets_json_and_a_bearer_token(client, stub, monkeypatch):
    monkeypatch.setattr(config, "PUBLIC_URL", "https://horde.example")
    resp = client.post(
        "/api/notifications/test",
        json={
            "name": "Hook",
            "kind": "webhook",
            "url": stub.base + "/in/abc",
            "token": "wh-secret",
        },
    )
    assert resp.json()["ok"] is True
    (req,) = stub.requests
    assert req["path"] == "/in/abc"
    assert req["headers"]["content-type"] == "application/json"
    assert req["headers"]["authorization"] == "Bearer wh-secret"
    body = json.loads(req["body"])
    assert set(body) == {"event", "title", "message", "url", "data", "sent_at"}
    assert body["event"] == "test"
    assert body["title"] == "Horde test notification"
    assert body["url"] == "https://horde.example/settings?tab=system"
    assert body["data"]["count"] == 1 and body["data"]["path"] == "/settings?tab=system"
    assert body["sent_at"].endswith("+00:00")


def test_discord_gets_content_and_cannot_ping_anyone(client, stub):
    resp = client.post(
        "/api/notifications/test",
        json={"name": "D", "kind": "discord", "url": stub.base + "/api/webhooks/1/x"},
    )
    assert resp.json()["ok"] is True
    (req,) = stub.requests
    body = json.loads(req["body"])
    assert body["content"].startswith("**Horde test notification**\n")
    assert body["allowed_mentions"] == {"parse": []}
    assert "authorization" not in req["headers"]


def test_the_test_of_a_saved_target_can_borrow_its_token(client, stub):
    made = client.post(
        "/api/notifications/targets",
        json={
            "name": "Hook",
            "kind": "webhook",
            "url": stub.base,
            "token": "stored-1234",
        },
    ).json()
    client.post(
        "/api/notifications/test",
        json={
            "id": made["id"],
            "name": "Hook",
            "kind": "webhook",
            "url": stub.base,
            "token": "••••1234",
        },
    )
    assert stub.requests[0]["headers"]["authorization"] == "Bearer stored-1234"


@pytest.mark.parametrize(
    ("status", "needle"),
    [
        (401, "rejected the credentials"),
        (403, "rejected the credentials"),
        (404, "Not found"),
        (429, "rate limiting"),
        (500, "HTTP 500"),
    ],
)
def test_a_refusal_comes_back_as_a_short_sentence(client, stub, status, needle):
    stub.status = status
    result = client.post(
        "/api/notifications/test",
        json={"name": "P", "kind": "ntfy", "url": stub.base, "topic": "t"},
    ).json()
    assert result["ok"] is False and result["status_code"] == status
    assert needle in result["error"]
    assert stub.base not in result["error"]


def test_redirects_are_not_followed(client, stub):
    stub.status = 302
    stub.headers = {"Location": "http://127.0.0.1:9/elsewhere"}
    result = client.post(
        "/api/notifications/test",
        json={"name": "P", "kind": "webhook", "url": stub.base},
    ).json()
    assert result["ok"] is False and result["status_code"] == 302
    assert "Redirects are not followed" in result["error"]
    assert len(stub.requests) == 1


def test_an_unreachable_server_is_reported_without_the_address(client, stub):
    base = stub.base  # nothing listens here once the next line closes it
    port = int(base.rsplit(":", 1)[1])
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        free = s.getsockname()[1]
    assert free != port
    result = client.post(
        "/api/notifications/test",
        json={
            "name": "P",
            "kind": "ntfy",
            "url": f"http://127.0.0.1:{free}",
            "topic": "secret-topic",
        },
    ).json()
    assert result == {
        "ok": False,
        "status_code": None,
        "error": "Could not connect to the server",
    }


def test_testing_an_invalid_target_is_refused(client):
    resp = client.post(
        "/api/notifications/test",
        json={"name": "P", "kind": "ntfy", "url": "file:///etc/passwd", "topic": "t"},
    )
    assert resp.status_code == 422


# -- the notifier ------------------------------------------------------------------------


def test_an_emitted_event_reaches_only_the_targets_that_want_it(notifier):
    n, sent, _clock = notifier()
    _add_target(name="Failures")  # download_failed by default
    _add_target(name="Everything", events=[s.name for s in events.EVENTS])
    _add_target(name="Off", enabled=False)
    _add_target(name="Updates only", events=["update_available"])

    n.emit("queue_held", {"reason": "Paused: library is at its 55 GB limit"})
    n.pump()

    assert sorted(t["name"] for t, _m in sent.sent) == ["Everything", "Failures"]
    assert sent.sent[0][1].body == "Paused: library is at its 55 GB limit"
    assert sent.sent[0][1].urgent is True


def test_a_deleted_target_loses_what_was_queued_for_it(notifier):
    n, sent, _clock = notifier()
    target = _add_target()
    n.emit("queue_held", {"reason": "x"})
    targets.delete_target(target["id"])
    n.pump()
    assert sent.sent == []


def test_unknown_events_and_nobody_listening_are_ignored(notifier, caplog):
    n, sent, _clock = notifier()
    _add_target()
    with caplog.at_level(logging.WARNING):
        n.emit("made_up", {})
    n.emit("update_available", {})  # nobody subscribed
    n.pump()
    assert sent.sent == []
    assert "made_up" in caplog.text


def test_emit_never_raises(notifier, monkeypatch):
    n, _sent, _clock = notifier()

    def broken(*_a: Any) -> None:
        raise RuntimeError("settings exploded")

    monkeypatch.setattr(targets, "subscribers", broken)
    n.emit("download_failed", {})  # must not raise


def test_a_full_queue_drops_the_oldest(notifier):
    n, sent, _clock = notifier(max_queue=3)
    _add_target(events=["queue_held"])
    for i in range(5):
        n.emit("queue_held", {"reason": f"r{i}"})
    n.pump()
    assert [m.body for _t, m in sent.sent] == ["r2", "r3", "r4"]


def test_a_flapping_event_is_sent_once(notifier):
    n, sent, clock = notifier()
    _add_target(events=["queue_held"])
    for _ in range(3):
        n.emit("queue_held", {"reason": "r"}, dedupe_key="held", dedupe_ttl=100)
    n.pump()
    assert len(sent.sent) == 1
    clock.now += 101
    n.emit("queue_held", {"reason": "r"}, dedupe_key="held", dedupe_ttl=100)
    n.pump()
    assert len(sent.sent) == 2


def test_a_failed_send_is_tried_three_times_then_dropped(notifier, caplog):
    boom = [DeliveryError("Could not connect to the server", retryable=True)] * 5
    n, sent, _clock = notifier(failures=boom)
    _add_target(events=["queue_held"], token="tk_topsecret")
    with caplog.at_level(logging.WARNING):
        n.emit("queue_held", {"reason": "r"})
        n.pump()
    assert len(sent.sent) == 3
    assert "failed after 3 attempt(s)" in caplog.text
    assert "tk_topsecret" not in caplog.text
    n.pump()
    assert len(sent.sent) == 3  # dropped, not requeued


def test_a_transient_failure_is_retried_until_it_works(notifier):
    n, sent, _clock = notifier(
        failures=[
            DeliveryError("blip", retryable=True),
            DeliveryError("blip", retryable=True),
        ]
    )
    _add_target(events=["queue_held"])
    n.emit("queue_held", {"reason": "r"})
    n.pump()
    assert len(sent.sent) == 3  # the third attempt got through


def test_a_refusal_is_not_retried(notifier, caplog):
    n, sent, _clock = notifier(
        failures=[DeliveryError("rejected the credentials", status_code=401)]
    )
    _add_target(events=["queue_held"])
    with caplog.at_level(logging.WARNING):
        n.emit("queue_held", {"reason": "r"})
        n.pump()
    assert len(sent.sent) == 1
    assert "rejected the credentials" in caplog.text


def test_a_burst_becomes_one_summary_per_minute(notifier):
    n, sent, clock = notifier()
    _add_target(events=["download_completed"], options={"only_automatic": False})
    done = {"origin": "channel_autodownload", "destination": "library"}

    n.emit("download_completed", {**done, "title": "First"})
    n.pump()
    assert sent.titles == ["Downloaded: First"]  # a quiet period: no waiting

    for i in range(30):
        n.emit("download_completed", {**done, "title": f"Clip {i}"})
    clock.now += 40
    assert n.pump() == pytest.approx(20)  # told how long until the summary is due
    assert len(sent.sent) == 1

    clock.now += 21
    n.pump()
    assert sent.titles[-1] == "30 new videos downloaded"
    assert sent.sent[-1][1].data["count"] == 30
    assert "and 25 more" in sent.sent[-1][1].body

    n.pump()  # nothing left
    assert len(sent.sent) == 2


def test_each_target_is_folded_on_its_own(notifier):
    n, sent, _clock = notifier()
    _add_target(name="A", events=["download_failed"])
    _add_target(name="B", events=["download_failed"])
    for i in range(3):
        n.emit("download_failed", {"title": f"v{i}", "error": "boom"})
    n.pump()
    # One immediate message each; the other two wait for their own summary.
    assert sorted(t["name"] for t, _m in sent.sent) == ["A", "B"]


def test_only_automatic_skips_what_somebody_queued(notifier):
    n, sent, clock = notifier()
    _add_target(name="Auto only", events=["download_completed"])
    _add_target(
        name="All", events=["download_completed"], options={"only_automatic": False}
    )
    n.emit("download_completed", {"title": "Mine", "origin": "manual"})
    n.emit("download_completed", {"title": "Theirs", "origin": "playlist_sync"})
    n.pump()
    clock.now += 61  # the second one for "All" was held back to be folded
    n.pump()
    assert sorted((t["name"], m.title) for t, m in sent.sent) == [
        ("All", "Downloaded: Mine"),
        ("All", "Downloaded: Theirs"),
        ("Auto only", "Downloaded: Theirs"),
    ]


def test_the_worker_delivers_in_the_background_and_stops(notifier):
    n, sent, _clock = notifier()
    _add_target(events=["queue_held"])
    worker = n.create_worker()
    worker.start()
    try:
        n.emit("queue_held", {"reason": "r"})
        deadline = time.monotonic() + 10
        while not sent.sent and time.monotonic() < deadline:
            time.sleep(0.02)
        assert len(sent.sent) == 1
    finally:
        assert worker.stop(5)


def test_the_worker_delivers_over_http(notifier, stub):
    n, _recorder, _clock = notifier()
    n._sender = __import__(
        "app.services.notifications.delivery", fromlist=["send"]
    ).send
    _add_target(url=stub.base, topic="real", events=["download_failed"])
    worker = n.create_worker()
    worker.start()
    try:
        n.emit(
            "download_failed",
            {"title": "A clip", "channel": "Chan", "error": "Sign in to confirm"},
        )
        deadline = time.monotonic() + 10
        while not stub.requests and time.monotonic() < deadline:
            time.sleep(0.02)
    finally:
        assert worker.stop(5)
    (req,) = stub.requests
    assert req["path"] == "/real"
    assert req["headers"]["title"] == "Download failed: A clip"
    assert req["headers"]["priority"] == "high"
    assert req["body"] == "Chan — Sign in to confirm".encode()


# -- wording ---------------------------------------------------------------------------


def test_texts_are_one_line_and_bounded():
    message = render(
        "download_failed",
        [{"title": "Multi\nline\x00 title", "channel": "C", "error": "e" * 1000}],
    )
    assert "\n" not in message.title and "\x00" not in message.title
    assert len(message.body) <= 400


def test_the_sample_is_a_plain_message():
    assert sample().event == "test"


# -- hook points ---------------------------------------------------------------------------


@pytest.fixture
def fake(init_db, monkeypatch):
    f = FakeYtdlp()
    f.install(monkeypatch)
    stub_media_probes(monkeypatch)
    return f


def _add_job(init_db, **fields: Any) -> int:
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url=fields.pop("url", URL),
            quality_preset="best",
            status=JobStatus.queued,
            **fields,
        )
        s.add(job)
        s.commit()
        return job.id  # type: ignore[return-value]


def test_a_failed_download_notifies(init_db, fake, notifier):
    n, sent, _clock = notifier()
    _add_target()
    fake.fetch_error = RuntimeError("Sign in to confirm you're not a bot")
    job_id = _add_job(init_db, title="My clip", channel="Chan")

    run_job_inline(job_id)
    n.pump()

    (target, message), *rest = sent.sent
    assert rest == []
    assert message.event == "download_failed"
    assert message.title == "Download failed: My clip"
    assert "Chan" in message.body
    assert message.data["items"][0]["job_id"] == job_id
    assert message.data["items"][0]["error_kind"]
    assert message.path == "/download"


def test_a_finished_download_notifies_those_who_asked(init_db, fake, notifier):
    n, sent, clock = notifier()
    _add_target(
        name="Auto", events=["download_completed"], options={"only_automatic": True}
    )
    _add_target(
        name="Everything",
        events=["download_completed"],
        options={"only_automatic": False},
    )
    fake.add(URL, make_info("notify00001", "Clip"))
    automatic = _add_job(init_db, origin=JobOrigin.channel_autodownload.value)
    run_job_inline(automatic)
    manual = _add_job(init_db, url=URL + "&x=1")
    fake.add(URL + "&x=1", make_info("notify00002", "Other"))
    run_job_inline(manual)
    n.pump()
    clock.now += 61  # a second message for the same target waits to be folded
    n.pump()

    got = sorted((t["name"], m.data["items"][0]["origin"]) for t, m in sent.sent)
    assert got == [
        ("Auto", "channel_autodownload"),
        ("Everything", "channel_autodownload"),
        ("Everything", "manual"),
    ]
    assert sent.sent[0][1].title.startswith("Downloaded: ")


def test_a_device_download_does_not_count_as_a_library_download(init_db, notifier):
    from app.services.downloads import dbwrite

    n, sent, _clock = notifier()
    _add_target(events=["download_completed"], options={"only_automatic": False})
    job_id = _add_job(init_db, destination="device")
    dbwrite.update_job(job_id, status=JobStatus.completed)
    n.pump()
    assert sent.sent == []


def test_a_job_reported_twice_notifies_once(init_db, notifier):
    from app.services.downloads import dbwrite

    n, sent, _clock = notifier()
    _add_target()
    job_id = _add_job(init_db, title="Clip")
    dbwrite.update_job(job_id, status=JobStatus.error, error="boom")
    dbwrite.update_job(job_id, status=JobStatus.error, error="boom again")
    n.pump()
    assert len(sent.sent) == 1


def test_an_ordinary_job_update_sends_nothing(init_db, notifier):
    from app.services.downloads import dbwrite

    n, sent, _clock = notifier()
    _add_target(events=[s.name for s in events.EVENTS])
    job_id = _add_job(init_db)
    dbwrite.update_job(job_id, progress=50.0, status=JobStatus.downloading)
    n.pump()
    assert sent.sent == []


# -- the queue holding ----------------------------------------------------------------------


def test_the_queue_going_on_hold_notifies_once(init_db, notifier, monkeypatch):
    from app.services.downloads import space
    from app.services.downloads.queue import DownloadQueue

    n, sent, clock = notifier()
    _add_target()
    gb = 1024**3
    app_settings.save({"max_library_bytes": 10 * gb})
    monkeypatch.setattr(space.SpaceGate, "library_bytes", lambda self: 10 * gb)
    monkeypatch.setattr(DownloadQueue, "_dispatch", lambda self: None)
    queue = DownloadQueue()
    _add_job(init_db)

    assert queue._next_job_id() is None
    assert queue._next_job_id() is None  # still held: no second message
    n.pump()
    assert len(sent.sent) == 1
    message = sent.sent[0][1]
    assert message.event == "queue_held"
    assert message.body == "Paused: library is at its 10 GB limit"

    # Room appears and goes again within the half hour: not worth another message.
    monkeypatch.setattr(space.SpaceGate, "library_bytes", lambda self: 1 * gb)
    assert queue._next_job_id() is not None
    monkeypatch.setattr(space.SpaceGate, "library_bytes", lambda self: 10 * gb)
    assert queue._next_job_id() is None
    n.pump()
    assert len(sent.sent) == 1

    clock.now += 1801
    monkeypatch.setattr(space.SpaceGate, "library_bytes", lambda self: 1 * gb)
    queue._next_job_id()
    monkeypatch.setattr(space.SpaceGate, "library_bytes", lambda self: 10 * gb)
    queue._next_job_id()
    n.pump()
    assert len(sent.sent) == 2


# -- going live -------------------------------------------------------------------------------


def _broadcast(video_id: str = "live0000001"):
    from app.services.live.page import LiveBroadcast

    return LiveBroadcast(
        video_id=video_id,
        title="Q&A",
        channel_name="Chan",
        game=None,
        viewers=3,
        started_at=None,
    )


def test_a_channel_going_live_notifies_once(notifier):
    from app.services.live.directory import ChannelLiveState, _announce_if_new

    n, sent, _clock = notifier()
    _add_target(events=["channel_live"])
    offline = ChannelLiveState("https://yt/c/a", "Chan", None, 1.0)
    live = ChannelLiveState("https://yt/c/a", "Chan", _broadcast(), 2.0, 2.0)

    _announce_if_new(None, "https://yt/c/a", "Chan", _broadcast())  # first look: quiet
    _announce_if_new(live, "https://yt/c/a", "Chan", _broadcast())  # still live: quiet
    _announce_if_new(offline, "https://yt/c/a", "Chan", None)  # not live: quiet
    n.pump()
    assert sent.sent == []

    _announce_if_new(offline, "https://yt/c/a", "Chan", _broadcast())
    _announce_if_new(offline, "https://yt/c/a", "Chan", _broadcast())  # flapped
    n.pump()
    assert len(sent.sent) == 1
    assert sent.sent[0][1].title == "Chan is live"
    assert sent.sent[0][1].body == "Q&A"


# -- updates ---------------------------------------------------------------------------------------


def _write_update_status(init_db, **env: str) -> None:
    root = init_db["data"] / "update"
    root.mkdir(parents=True, exist_ok=True)
    (root / "watcher.env").write_text("LAST_SEEN=2999-01-01T00:00:00+00:00\n")
    (root / "status.env").write_text(
        "".join(f"{k}={v}\n" for k, v in env.items()), encoding="utf-8"
    )


def test_a_failed_update_is_reported_once(init_db, notifier):
    from datetime import UTC, datetime

    n, sent, _clock = notifier()
    _add_target()
    _write_update_status(
        init_db,
        REQUEST_ID="a" * 32,
        STATE="rolled_back",
        FINISHED_AT=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
    watchers.check_updates(n)
    watchers.check_updates(n)  # the same run again: nothing new
    n.pump()
    assert [m.title for _t, m in sent.sent] == ["Horde update rolled back"]
    assert app_settings.load()["notification_state"]["update_failed"] == "a" * 32


def test_an_old_failure_is_history(init_db, notifier):
    n, sent, _clock = notifier()
    _add_target()
    _write_update_status(
        init_db,
        REQUEST_ID="b" * 32,
        STATE="failed",
        FINISHED_AT="2020-01-01T00:00:00Z",
    )
    watchers.check_updates(n)
    n.pump()
    assert sent.sent == []


def test_a_new_release_is_reported_once(init_db, notifier, monkeypatch):
    n, sent, _clock = notifier()
    _add_target(events=["update_available"])
    found = {
        "update_available": True,
        "latest_sha": "v1.2.0",
        "latest_short": "1.2.0",
        "current_short": "1.1.0",
        "latest_html_url": "https://github.com/x/y/releases/tag/v1.2.0",
    }
    monkeypatch.setattr(
        "app.services.updates.check_for_updates", lambda **_k: dict(found)
    )
    watchers.check_updates(n)
    watchers.check_updates(n)
    n.pump()
    assert len(sent.sent) == 1
    assert sent.sent[0][1].body == "Horde 1.2.0 is available. This server runs 1.1.0."

    found["latest_sha"] = "v1.3.0"
    watchers.check_updates(n)
    n.pump()
    assert len(sent.sent) == 2


def test_nothing_is_looked_up_when_nobody_listens(init_db, notifier, monkeypatch):
    n, sent, _clock = notifier()
    _add_target(events=["download_failed"])

    def forbidden(**_k: Any) -> dict[str, Any]:
        raise AssertionError("no one subscribed to updates")

    monkeypatch.setattr("app.services.updates.check_for_updates", forbidden)
    watchers.check_updates(n)
    assert sent.sent == []


def test_the_module_function_without_a_context_does_not_raise(monkeypatch):
    from app import context

    monkeypatch.setattr(context, "_active", None)
    notifications.emit("download_failed", {})
