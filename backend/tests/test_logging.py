"""Logging configuration and request / job correlation IDs."""

from __future__ import annotations

import json
import logging

import pytest

from app import logging_config
from app.logging_config import (
    ContextFilter,
    JsonFormatter,
    build_config,
    job_context,
    resolve_format,
    resolve_level,
    sane_request_id,
)


def _record(msg: str = "hello", level: int = logging.INFO) -> logging.LogRecord:
    return logging.LogRecord("horde.test", level, __file__, 1, msg, None, None)


def test_level_and_format_fall_back_to_defaults():
    assert resolve_level("debug") == "DEBUG"
    assert resolve_level("nonsense") == "INFO"
    assert resolve_level(None) == "INFO"
    assert resolve_format("JSON") == "json"
    assert resolve_format("anything") == "text"


def test_json_formatter_carries_request_and_job_ids():
    record = _record("started")
    token = logging_config.request_id_var.set("req-1")
    try:
        with job_context("download-7"):
            ContextFilter().filter(record)
            line = JsonFormatter().format(record)
    finally:
        logging_config.request_id_var.reset(token)
    data = json.loads(line)
    assert data["message"] == "started"
    assert data["level"] == "INFO"
    assert data["logger"] == "horde.test"
    assert data["request_id"] == "req-1"
    assert data["job_id"] == "download-7"
    assert "thread" in data and "ts" in data


def test_json_formatter_includes_the_traceback():
    try:
        raise ValueError("bad")
    except ValueError:
        import sys

        record = logging.LogRecord(
            "horde.test", logging.ERROR, __file__, 1, "failed", None, sys.exc_info()
        )
    ContextFilter().filter(record)
    assert "ValueError: bad" in json.loads(JsonFormatter().format(record))["exc_info"]


def test_text_format_has_thread_and_ids_only_when_present():
    config = build_config("INFO", "text")
    formatter = logging.Formatter(
        config["formatters"]["horde"]["format"],
        config["formatters"]["horde"]["datefmt"],
    )
    plain = _record()
    ContextFilter().filter(plain)
    assert "request_id" not in formatter.format(plain)
    with job_context("ai-3"):
        tagged = _record()
        ContextFilter().filter(tagged)
    out = formatter.format(tagged)
    assert "job_id=ai-3" in out
    assert "[MainThread]" in out


def test_uvicorn_loggers_share_the_app_handler():
    config = build_config("WARNING", "json")
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        assert config["loggers"][name]["handlers"] == []
        assert config["loggers"][name]["propagate"] is True
    assert config["root"]["level"] == "WARNING"
    assert config["formatters"]["horde"]["()"].endswith("JsonFormatter")


@pytest.mark.parametrize(
    ("value", "ok"),
    [
        ("abc-123_x.y:z", True),
        ("a" * 64, True),
        ("a" * 65, False),
        ("has space", False),
        ("new\nline", False),
        ("", False),
        (None, False),
    ],
)
def test_incoming_request_ids_must_be_short_and_printable(value, ok):
    assert (sane_request_id(value) is not None) is ok


def test_response_echoes_a_sane_request_id(client):
    response = client.get("/api/ping", headers={"X-Request-ID": "proxy-abc123"})
    assert response.headers["X-Request-ID"] == "proxy-abc123"


def test_response_replaces_an_unsafe_request_id(client):
    response = client.get("/api/ping", headers={"X-Request-ID": "bad id with spaces"})
    echoed = response.headers["X-Request-ID"]
    assert echoed != "bad id with spaces"
    assert len(echoed) == 16


def test_every_response_gets_a_fresh_request_id(client):
    first = client.get("/api/ping").headers["X-Request-ID"]
    second = client.get("/api/ping").headers["X-Request-ID"]
    assert first != second


def test_rejected_requests_carry_the_id_too(raw_client):
    # CSRF rejection happens inside the stack; the ID middleware sits outside it.
    response = raw_client.post("/api/downloads/pause")
    assert response.status_code == 403
    assert response.headers["X-Request-ID"]


def test_request_id_reaches_log_records_made_in_handlers(client):
    seen: list[str | None] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            seen.append(getattr(record, "request_id", None))

    handler = Capture()
    handler.addFilter(ContextFilter())
    logging.getLogger("app.security").addHandler(handler)
    try:
        client.get(
            "/api/ping", headers={"Host": "evil.example", "X-Request-ID": "rid-9"}
        )
    finally:
        logging.getLogger("app.security").removeHandler(handler)
    assert seen == ["rid-9"]


def test_failure_log_warns_once_then_stays_quiet_until_recovery(caplog):
    from app.logging_config import FailureLog

    log = logging.getLogger("horde.failure-test")
    caplog.set_level(logging.DEBUG, logger="horde.failure-test")
    failures = FailureLog(log, "poll failed")
    for _ in range(3):
        try:
            raise OSError("nas offline")
        except OSError:
            failures.failed()
    levels = [r.levelno for r in caplog.records]
    assert levels == [logging.WARNING, logging.DEBUG, logging.DEBUG]
    assert all(r.exc_info for r in caplog.records)

    failures.ok()
    failures.ok()  # only the first success after failures says anything
    assert [r.levelno for r in caplog.records][3:] == [logging.INFO]
    try:
        raise OSError("again")
    except OSError:
        failures.failed()
    assert caplog.records[-1].levelno == logging.WARNING
