"""The JSON shape of routes that used to return ad-hoc dicts.

Their response models strip any key the model does not name, so each route is hit
once and compared with the keys the SPA reads.
"""

from __future__ import annotations

from app.models import VideoAiChatMessage


def test_health_full_and_public(client, anon_client):
    full = client.get("/api/health")
    assert full.status_code == 200
    body = full.json()
    assert set(body) >= {
        "status",
        "horde_sha",
        "yt_dlp_version",
        "ffmpeg",
        "pot_provider",
        "ollama",
        "openrouter",
        "disk",
        "storage_warning",
        "library_video_count",
        "review_pending_count",
        "active_downloads",
        "wiki_available",
        "downloads",
        "workers",
        "youtube",
    }
    assert set(body["workers"]) == {
        "ai_queue_depth",
        "ai_running",
        "ai_error_count",
        "ai_blocked_reason",
        "catalog_queue_depth",
        "catalog_indexing",
    }
    assert set(body["youtube"]) == {"cookies_configured", "last_extract_failure"}

    public = anon_client.get("/api/health")
    assert public.status_code == 200
    assert set(public.json()) == {"status", "setup_required", "auth_required"}


def test_ping(client):
    assert client.get("/api/ping").json() == {"ok": True}


def test_system_stats_and_activity(client):
    stats = client.get("/api/system/stats").json()
    assert set(stats) == {
        "cpu_percent",
        "cpu_model",
        "cpu_temp_c",
        "cpu_count",
        "ram_used_bytes",
        "ram_total_bytes",
        "ram_percent",
        "gpu",
        "disk",
        "encode",
    }
    assert set(stats["disk"]) == {"total_bytes", "used_bytes", "free_bytes"}
    activity = client.get("/api/system/activity").json()
    assert set(activity) == {"running", "recent", "queued", "cpu_percent"}


def test_updates(client, monkeypatch):
    payload = {
        "repo": "owner/horde",
        "source": "release",
        "current_sha": "a" * 40,
        "current_short": "v1.0.0",
        "current_version": "1.0.0",
        "latest_sha": "b" * 40,
        "latest_short": "v1.1.0",
        "latest_version": "1.1.0",
        "latest_html_url": "https://example.com/release",
        "update_available": True,
        "checked_at": "2026-01-01T00:00:00+00:00",
        "error": None,
    }
    monkeypatch.setattr(
        "app.services.updates.check_for_updates", lambda refresh=False: dict(payload)
    )
    assert client.get("/api/updates").json() == payload


def test_compat_summary_and_cancel(client, add_video):
    add_video(vcodec="h264", media_probed_at=None)
    summary = client.get("/api/compat/summary").json()
    assert set(summary) == {
        "copy_cap",
        "videos",
        "library_bytes",
        "by_codec",
        "unprobed",
        "compat_ready",
        "compat_bytes",
        "compat_missing",
        "compat_missing_est_bytes",
        "convertible",
        "convertible_bytes",
        "queued",
        "running",
        "convert_queued",
        "convert_running",
    }
    assert summary["videos"] == 1
    assert client.post("/api/compat/cancel", json={}).json() == {"cancelled": 0}


def test_ai_controls(client):
    assert client.post("/api/ai/pause").json() == {"paused": True}
    assert client.post("/api/ai/resume").json() == {"paused": False}
    assert client.post("/api/ai/jobs/retry-failed").json() == {"ok": True, "retried": 0}
    assert client.post("/api/ai/jobs/clear-failed").json() == {"ok": True, "deleted": 0}
    assert client.post("/api/ai/jobs/999999/retry").status_code == 404
    assert client.get("/api/ai/categories").json() == {"categories": []}


def test_ai_connection_tests_keep_their_optional_keys_absent(client, monkeypatch):
    monkeypatch.setattr(
        "app.api.ai.test_connection",
        lambda base_url: {"ok": False, "base_url": base_url, "detail": "Unreachable"},
    )
    assert client.post("/api/ai/test", json={"base_url": "http://x"}).json() == {
        "ok": False,
        "base_url": "http://x",
        "detail": "Unreachable",
    }
    monkeypatch.setattr(
        "app.api.ai.test_openrouter_connection",
        lambda key: {"ok": True, "detail": "Connected (2 models)", "model_count": 2},
    )
    assert client.post("/api/ai/openrouter/test", json={}).json() == {
        "ok": True,
        "detail": "Connected (2 models)",
        "model_count": 2,
    }


def test_apply_workload(client, monkeypatch):
    body = client.post("/api/ai/apply-workload", json={"profile": "light"}).json()
    assert set(body) == {"ok", "runtime", "embed_model_changed", "pulled", "detail"}
    assert body["runtime"]["profile"] == "light"
    assert set(body["runtime"]) >= {
        "profile",
        "embed_model",
        "chat_model",
        "gpu_source",
    }


def test_backgrounds_and_fonts_lists(client):
    assert client.get("/api/backgrounds").json() == {"items": []}
    assert client.get("/api/fonts").json() == {"items": []}
    assert client.delete("/api/backgrounds/nope").status_code in (200, 404)


def test_rename_channel(client, add_video):
    add_video(channel="Old")
    resp = client.patch("/api/channels", json={"old_name": "Old", "new_name": "New"})
    assert resp.json() == {"updated": 1}


def test_video_ai_chat_history(client, session, add_video, admin_user):
    video = add_video()
    session.add(
        VideoAiChatMessage(
            video_id=video.id, user_id=admin_user.id, role="user", content="hello"
        )
    )
    session.commit()
    messages = client.get(f"/api/videos/{video.id}/ai/chat").json()["messages"]
    assert [m["content"] for m in messages] == ["hello"]
    assert set(messages[0]) == {"id", "role", "content", "cost", "model", "created_at"}
    assert client.delete(f"/api/videos/{video.id}/ai/chat").json() == {"ok": True}
    assert client.get(f"/api/videos/{video.id}/ai/chat").json() == {"messages": []}


def test_sprite_generate_status(client, add_video, monkeypatch):
    video = add_video()
    monkeypatch.setattr(
        "app.api.videos.enqueue_sprite_generation", lambda *a, **k: "generating"
    )
    resp = client.post(f"/api/videos/{video.id}/sprites/generate")
    assert resp.json() == {"status": "generating"}
