"""GET /api/metrics: Prometheus text format, cheap, and fed by real state."""

from __future__ import annotations

import re

from sqlmodel import Session

from app.models import AiJob, AiJobKind, AiJobStatus, DownloadJob, JobStatus
from app.services.workers import BackgroundWorker, WorkerRegistry

SAMPLE = re.compile(
    r'^[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="[^"]*"(,|(?=\})))*\})? '
    r"-?\d+(\.\d+)?$"
)


def _samples(text: str) -> dict[str, float]:
    out = {}
    for line in text.splitlines():
        if line.startswith("#") or not line:
            continue
        assert SAMPLE.match(line), f"not a valid exposition line: {line!r}"
        name, value = line.rsplit(" ", 1)
        out[name] = float(value)
    return out


def test_metrics_are_valid_prometheus_text(client):
    response = client.get("/api/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain; version=0.0.4")
    text = response.text
    assert text.endswith("\n")
    # Every family has HELP and TYPE before its samples.
    families = re.findall(r"^# TYPE (\S+) (gauge|counter)$", text, flags=re.M)
    assert families
    for name, _kind in families:
        assert f"# HELP {name} " in text
    _samples(text)


def test_queue_depths_come_from_the_database(client, init_db):
    with Session(init_db["engine"]) as session:
        for status in (JobStatus.queued, JobStatus.queued, JobStatus.downloading):
            session.add(DownloadJob(url="https://example.com/v", status=status))
        session.add(AiJob(kind=AiJobKind.embed_video, status=AiJobStatus.queued))
        session.commit()
    samples = _samples(client.get("/api/metrics").text)
    assert samples['horde_download_jobs{status="queued"}'] == 2
    assert samples['horde_download_jobs{status="downloading"}'] == 1
    assert samples['horde_download_jobs{status="completed"}'] == 0
    assert samples['horde_ai_jobs{status="queued"}'] == 1
    assert samples["horde_download_queue_paused"] == 0
    assert samples['horde_db_size_bytes{file="db"}'] > 0
    assert samples['horde_disk_bytes{volume="downloads",kind="free"}'] > 0


def test_worker_flags_follow_the_registry(app, client):
    registry = WorkerRegistry()
    registry.start(BackgroundWorker("alive-one", lambda w: w.sleep(30)))
    dead = BackgroundWorker("dead-one", lambda _w: None)
    registry.start(dead)
    dead._thread.join(2)
    dead._crashed = True
    app.state.workers = registry
    try:
        samples = _samples(client.get("/api/metrics").text)
        assert samples['horde_worker_up{worker="alive-one"}'] == 1
        assert samples['horde_worker_up{worker="dead-one"}'] == 0
    finally:
        registry.stop_all()


def test_requests_are_counted_by_status_class(client):
    before = _samples(client.get("/api/metrics").text)
    client.get("/api/ping")
    client.get("/api/ping")
    client.get("/api/videos/999999")  # 404
    after = _samples(client.get("/api/metrics").text)

    def delta(klass):
        key = f'horde_http_requests_total{{status_class="{klass}"}}'
        return after[key] - before[key]

    assert delta("2xx") >= 3  # two pings plus the first scrape
    assert delta("4xx") == 1
    assert delta("5xx") == 0
    assert after["horde_http_request_seconds_total"] > 0


def test_label_values_are_escaped():
    from app.services.metrics import _label_value

    assert _label_value('a"b\\c\nd') == 'a\\"b\\\\c\\nd'
