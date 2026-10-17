"""A member sees coarse status, never provider addresses, models, GPU details or raw errors.

Each test reads the same endpoint as an administrator (full detail) and as a
member (trimmed by ``app/api/member_view.py``).
"""

from __future__ import annotations

import httpx
import pytest

from app.api import member_view
from app.models import VideoAiMeta

EMBED_ERROR = (
    "Client error '401 Unauthorized' for url 'http://ollama.lan:11434/api/embed'"
)
COMPAT_ERROR = "ffmpeg exited 1: /srv/horde/downloads/Alpha/clip.mp4: Invalid data"


@pytest.fixture
def failed_video(add_video, session):
    video = add_video(title="Broken clip", compat_error=COMPAT_ERROR)
    session.add(
        VideoAiMeta(
            video_id=video.id,
            embed_status="error",
            embed_error=EMBED_ERROR,
            summary="A summary.",
            summary_model="vendor/private-model",
            summary_cost=0.0042,
        )
    )
    session.commit()
    return video


def test_a_video_read_hides_provider_errors_and_models_from_a_member(
    client, member_client, failed_video
):
    path = f"/api/videos/{failed_video.id}"
    admin, member = client.get(path).json(), member_client.get(path).json()

    assert admin["embed_error"] == EMBED_ERROR
    assert admin["ai_summary_model"] == "vendor/private-model"
    assert admin["ai_summary_cost"] == pytest.approx(0.0042)
    assert admin["compat"]["error"] == COMPAT_ERROR
    # The member still learns that indexing and the copy failed, not why.
    assert member["embed_status"] == "error"
    assert member["embed_error"] == member_view.EMBED_ERROR
    assert member["ai_summary"] == "A summary."
    assert member["ai_summary_model"] is None
    assert member["ai_summary_cost"] is None
    assert member["compat"]["status"] == "error"
    assert member["compat"]["error"] == member_view.COMPAT_ERROR


def test_the_compat_endpoint_hides_the_conversion_error_from_a_member(
    client, member_client, failed_video
):
    path = f"/api/videos/{failed_video.id}/compat"

    assert client.get(path).json()["error"] == COMPAT_ERROR
    seen = member_client.get(path).json()
    assert seen["status"] == "error"
    assert seen["error"] == member_view.COMPAT_ERROR


def test_system_activity_hides_engine_detail_and_error_from_a_member(
    client, member_client, monkeypatch
):
    from app.services import activity

    task = {
        "id": "t1",
        "kind": "model_pull",
        "group": "ai",
        "label": "Downloading an AI model",
        "reason": "Required Ollama model is missing",
        "engine": "ollama",
        "detail": "llama3.2:3b",
        "video_id": None,
        "done": None,
        "total": None,
        "status": "failed",
        "started_at": 1.0,
        "finished_at": 2.0,
        "error": "All connection attempts failed: http://ollama.lan:11434/api/pull",
    }
    monkeypatch.setattr(
        activity,
        "snapshot",
        lambda: {"running": [dict(task)], "recent": [dict(task)], "queued": {"ai": 1}},
    )

    admin = client.get("/api/system/activity").json()
    member = member_client.get("/api/system/activity").json()

    assert admin["recent"][0]["detail"] == "llama3.2:3b"
    assert "ollama.lan" in admin["recent"][0]["error"]
    for row in member["running"] + member["recent"]:
        assert row["engine"] is None
        assert row["detail"] is None
        assert row["error"] is None
    assert member["recent"][0]["status"] == "failed"
    assert member["queued"] == {"ai": 1}


def test_system_stats_hide_the_gpu_name_and_memory_from_a_member(
    client, member_client, monkeypatch
):
    from app.api import system
    from app.services import encode_probe

    monkeypatch.setattr(
        system,
        "host_gpu",
        lambda: {
            "name": "NVIDIA GeForce RTX 4090",
            "vendor": "nvidia",
            "util_percent": 12.0,
            "temp_c": 40.0,
            "vram_used_bytes": 1 << 30,
            "vram_total_bytes": 24 << 30,
        },
    )

    class _Caps:
        def to_dict(self):
            return {
                "hw_h264": True,
                "hw_hevc": True,
                "ffmpeg_has_hw_encoder": True,
                "gpu_name": "NVIDIA GeForce RTX 4090",
                "gpu_vendor": "nvidia",
                "encoder_h264": "h264_nvenc",
                "encoder_hevc": "hevc_nvenc",
                "ffmpeg_bin": "/opt/ffmpeg/bin/ffmpeg",
            }

    monkeypatch.setattr(encode_probe, "probe_encode_capabilities", lambda: _Caps())

    admin = client.get("/api/system/stats").json()
    member = member_client.get("/api/system/stats").json()

    assert admin["gpu"]["name"] == "NVIDIA GeForce RTX 4090"
    assert admin["gpu"]["vram_total_bytes"] == 24 << 30
    assert admin["encode"]["ffmpeg_bin"] == "/opt/ffmpeg/bin/ffmpeg"
    assert member["gpu"]["name"] is None
    assert member["gpu"]["vram_used_bytes"] is None
    assert member["gpu"]["vram_total_bytes"] is None
    assert member["gpu"]["util_percent"] == 12.0
    assert member["encode"]["gpu_name"] is None
    assert member["encode"]["ffmpeg_bin"] is None
    # The Library tab's compatibility panel still knows a GPU encoder is usable.
    assert member["encode"]["hw_h264"] is True
    assert member["encode"]["encoder_h264"] == "h264_nvenc"


def test_health_hides_the_pot_url_and_extract_failure_text_from_a_member(
    app, client, member_client, monkeypatch
):
    from app.services import ytdlp_common
    from app.services.health import HealthCache

    def unreachable(url, **kwargs):
        raise httpx.ConnectError(f"All connection attempts failed: {url}")

    monkeypatch.setattr(httpx, "get", unreachable)
    cache = HealthCache(pot_base_url="http://bgutil.lan:4416")
    cache.refresh_pot()
    monkeypatch.setattr(app.state, "health_cache", cache, raising=False)
    monkeypatch.setattr(
        ytdlp_common,
        "get_last_extract_failure",
        lambda: {
            "kind": "bot_check",
            "message": "ERROR: [youtube] abc: Sign in to confirm (via http://bgutil.lan:4416)",
            "at": "2026-10-16T00:00:00+00:00",
            "target": "Some video by Some channel",
            "url": "https://www.youtube.com/watch?v=abcdefghijk",
        },
    )

    admin = client.get("/api/health").json()
    member = member_client.get("/api/health").json()

    assert admin["pot_provider"]["url"] == "http://bgutil.lan:4416"
    assert "bgutil.lan" in admin["pot_provider"]["detail"]
    assert "bgutil.lan" in admin["youtube"]["last_extract_failure"]["message"]
    assert member["pot_provider"]["status"] == "error"
    assert member["pot_provider"]["url"] is None
    assert member["pot_provider"]["detail"] is None
    failure = member["youtube"]["last_extract_failure"]
    assert failure["kind"] == "bot_check"
    assert failure["message"] == member_view.EXTRACT_ERROR
    assert failure["url"] is None and failure["target"] is None
    assert "bgutil.lan" not in str(member)


def test_health_hides_the_data_path_in_the_storage_warning_from_a_member(
    app, client, member_client
):
    app.state.storage_warning = (
        "The data directory /srv/horde/data is on a network filesystem (nfs4 "
        "mounted at /srv). SQLite's write-ahead log (WAL) is not safe there."
    )

    admin = client.get("/api/health").json()
    member = member_client.get("/api/health").json()

    assert "/srv/horde/data" in admin["storage_warning"]
    # The member still learns that the storage is unsafe, not where it is.
    assert member["storage_warning"] == member_view.STORAGE_WARNING
    assert "/srv" not in str(member)


def test_health_without_a_storage_warning_stays_empty_for_a_member(app, member_client):
    app.state.storage_warning = None

    assert member_client.get("/api/health").json()["storage_warning"] is None


def test_the_catalog_status_hides_the_extractor_error_from_a_member(
    client, member_client, session
):
    from app.models import ChannelCatalog, ChannelCatalogStatus

    raw = "ERROR: [youtube:tab] UC1: Unable to download webpage: http://proxy.lan:3128"
    session.add(
        ChannelCatalog(
            channel_url="https://www.youtube.com/@alpha",
            channel_name="Alpha",
            status=ChannelCatalogStatus.error,
            last_error=raw,
        )
    )
    session.commit()
    path = "/api/channels/catalog/status"

    admin = client.get(path).json()["catalogs"]
    member = member_client.get(path).json()["catalogs"]

    assert [c["last_error"] for c in admin] == [raw]
    assert [c["status"] for c in member] == ["error"]
    assert [c["last_error"] for c in member] == [member_view.CATALOG_ERROR]


@pytest.mark.parametrize("live", [False, True])
def test_a_failed_channel_feed_logs_the_error_and_answers_with_a_stable_code(
    client, member_client, monkeypatch, caplog, live
):
    from app.services import ytdlp_extract

    raw = "ERROR: Unable to download webpage: http://proxy.lan:3128 (key=sk-abc123)"

    def boom(*args, **kwargs):
        raise RuntimeError(raw)

    monkeypatch.setattr(ytdlp_extract, "fetch_channel_feed", boom)
    params = {"url": "https://www.youtube.com/@alpha", "live": live}

    for who in (client, member_client):
        response = who.get("/api/channels/feed", params=params)
        body = response.json()
        assert response.status_code == 400
        assert body["code"] == "channel_feed_unavailable"
        assert "proxy.lan" not in str(body) and "sk-abc123" not in str(body)
    assert "proxy.lan" in caplog.text
