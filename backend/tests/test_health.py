"""Health, readiness and storage-safety probes."""

from __future__ import annotations

import subprocess
from pathlib import Path

import httpx
import pytest
import yt_dlp.version  # noqa: F401 - importing yt-dlp may fork; do it before forking is forbidden

from app import main
from app.services import health as health_svc
from app.services import storage_check
from app.services.workers import BackgroundWorker, WorkerRegistry

MOUNTINFO = r"""
22 28 0:21 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw
28 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw
60 28 0:50 / /mnt/nas rw,relatime shared:30 - nfs4 10.0.0.2:/tank rw,vers=4.2
61 60 0:51 / /mnt/nas/local rw,relatime shared:31 - ext4 /dev/sdb1 rw
62 28 0:52 / /srv/with\040space rw,relatime shared:32 - cifs //nas/share rw
63 28 0:53 / /srv/ssh rw,relatime shared:33 - fuse.sshfs user@host:/ rw
"""


def test_health_forks_nothing_and_never_touches_the_network(client, monkeypatch):
    def forbidden(*_a, **_k):
        raise AssertionError("health must not fork or call out")

    monkeypatch.setattr(subprocess, "run", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(httpx, "get", forbidden)
    # Warm the app-level cache (this builds it once), then poll like the UI does.
    client.get("/api/health")
    for _ in range(3):
        response = client.get("/api/health")
        assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["yt_dlp_version"] not in ("", "unknown")
    assert "storage_warning" in body


def test_health_reports_the_yt_dlp_the_app_imports(client):
    from yt_dlp.version import __version__

    assert client.get("/api/health").json()["yt_dlp_version"] == str(__version__)


def test_ffmpeg_flavor_comes_from_build_info(tmp_path):
    info = tmp_path / "BUILD_INFO"
    info.write_text("ffmpeg_flavor=jellyfin\nffmpeg=ffmpeg version 7.0.2-Jellyfin\n")
    cache = health_svc.HealthCache(build_info_path=info)
    assert cache.ffmpeg() == {
        "flavor": "jellyfin",
        "version": "ffmpeg version 7.0.2-Jellyfin",
    }
    assert health_svc.HealthCache(build_info_path=tmp_path / "missing").ffmpeg() is None


def test_pot_status_is_refreshed_by_the_probe_not_the_request(monkeypatch):
    cache = health_svc.HealthCache(pot_base_url="http://pot:4416")
    assert cache.pot_status()["status"] == "pending"

    calls: list[str] = []

    def fake_get(url, timeout):
        calls.append(url)
        return httpx.Response(
            200, json={"version": "1.3.2"}, request=httpx.Request("GET", url)
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    cache.refresh_pot()
    assert calls == ["http://pot:4416/ping"]
    for _ in range(5):  # reading never pings
        assert cache.pot_status() == {
            "status": "ok",
            "url": "http://pot:4416",
            "version": "1.3.2",
        }
    assert len(calls) == 1


def test_pot_probe_reports_errors(monkeypatch):
    cache = health_svc.HealthCache(pot_base_url="http://pot:4416")

    def refuse(url, timeout):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(httpx, "get", refuse)
    cache.refresh_pot()
    status = cache.pot_status()
    assert status["status"] == "error"
    assert "refused" in status["detail"]


def test_no_pot_sidecar_means_no_pot_block():
    assert health_svc.HealthCache(pot_base_url="").pot_status() is None


def test_ready_when_database_and_migrations_are_fine(client):
    response = client.get("/api/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is True
    assert body["database"] is True
    assert body["migrations"] is True
    assert body["problems"] == []


def test_not_ready_when_migrations_are_behind(client, monkeypatch):
    monkeypatch.setattr(health_svc, "stored_revision", lambda _engine: "0000_old")
    response = client.get("/api/ready")
    assert response.status_code == 503
    assert response.json()["problems"] == ["database is not at the latest migration"]


def test_not_ready_when_a_worker_died(app, client):
    dead = BackgroundWorker("doomed", lambda _w: None)
    registry = WorkerRegistry()
    registry.start(dead)
    dead._thread.join(2)
    dead._crashed = True
    app.state.workers = registry
    response = client.get("/api/ready")
    assert response.status_code == 503
    assert response.json()["workers"] == {"doomed": False}


def test_not_ready_when_the_database_is_unreachable(client, tmp_path, monkeypatch):
    from app.database import create_sqlite_engine

    broken = create_sqlite_engine(f"sqlite:///{tmp_path / 'missing-dir' / 'x.db'}")
    monkeypatch.setattr(main, "engine", broken)
    response = client.get("/api/ready")
    assert response.status_code == 503
    assert "database unreachable" in response.json()["problems"]


def test_ping_stays_a_pure_liveness_probe(client):
    assert client.get("/api/ping").json() == {"ok": True}


# -- storage safety ---------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "fstype"),
    [
        ("/mnt/nas/horde/data", "nfs4"),
        ("/mnt/nas", "nfs4"),
        ("/mnt/nas/local/data", "ext4"),  # nested local mount wins
        ("/srv/with space/db", "cifs"),
        ("/srv/ssh/x", "fuse.sshfs"),
        ("/home/user/data", "ext4"),
    ],
)
def test_filesystem_lookup_uses_the_longest_matching_mount(path, fstype):
    mounts = storage_check.parse_mountinfo(MOUNTINFO)
    assert storage_check.filesystem_of(Path(path), mounts)[1] == fstype


def test_warns_for_network_filesystems_only(tmp_path):
    info = tmp_path / "mountinfo"
    info.write_text(MOUNTINFO)
    warning = storage_check.network_storage_warning(Path("/mnt/nas/horde"), info)
    assert warning and "nfs4" in warning and "WAL" in warning
    assert storage_check.network_storage_warning(Path("/home/user"), info) is None


def test_missing_mountinfo_means_no_warning(tmp_path):
    assert (
        storage_check.network_storage_warning(Path("/data"), tmp_path / "nope") is None
    )


def test_storage_warning_is_surfaced_on_health(app, client):
    app.state.storage_warning = "DATA_DIR is on nfs4"
    assert client.get("/api/health").json()["storage_warning"] == "DATA_DIR is on nfs4"


def test_not_ready_once_shutdown_has_begun(app, client):
    import threading

    app.state.shutdown_event = threading.Event()
    assert client.get("/api/ready").status_code == 200
    app.state.shutdown_event.set()
    response = client.get("/api/ready")
    assert response.status_code == 503
    assert "shutting down" in response.json()["problems"]


def test_ready_does_not_spin_up_alembic_each_call(client, caplog):
    import logging

    client.get("/api/ready")  # builds the cache
    caplog.set_level(logging.INFO)
    caplog.clear()
    for _ in range(3):
        assert client.get("/api/ready").status_code == 200
    assert not [r for r in caplog.records if r.name.startswith("alembic")]
