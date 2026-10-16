"""HTTP regression: settings persist without touching live AI providers."""


def test_settings_get_defaults_and_patch_roundtrip(client):
    first = client.get("/api/settings")
    assert first.status_code == 200
    body = first.json()
    assert body["progress_expiry_days"] == 14
    assert body["direct_youtube_search"] is True
    assert body["youtube_video_search"] is True
    assert body["setup_completed"] is False
    assert "ui" in body
    assert "ai" in body
    assert body["ai"]["openrouter_api_key_set"] is False
    assert body["ai"]["openrouter_show_costs"] is False

    patched = client.patch(
        "/api/settings",
        json={
            "progress_expiry_days": 21,
            "channel_catalog_enabled": False,
            "ui": {"theme": "oled", "fontSize": "large"},
            "ai": {"enabled": False, "ai_chat": False},
        },
    )
    assert patched.status_code == 200
    out = patched.json()
    assert out["progress_expiry_days"] == 21
    assert out["channel_catalog_enabled"] is False
    assert out["ui"]["theme"] == "oled"
    assert out["ui"]["fontSize"] == "large"
    assert out["ai"]["enabled"] is False
    assert out["ai"]["ai_chat"] is False

    again = client.get("/api/settings").json()
    assert again["progress_expiry_days"] == 21
    assert again["ui"]["theme"] == "oled"
    assert again["ai"]["enabled"] is False


def test_settings_direct_youtube_search_roundtrip(client):
    patched = client.patch("/api/settings", json={"direct_youtube_search": False})
    assert patched.status_code == 200
    assert patched.json()["direct_youtube_search"] is False
    again = client.get("/api/settings").json()
    assert again["direct_youtube_search"] is False


def test_settings_youtube_video_search_roundtrip(client):
    patched = client.patch("/api/settings", json={"youtube_video_search": False})
    assert patched.status_code == 200
    assert patched.json()["youtube_video_search"] is False
    again = client.get("/api/settings").json()
    assert again["youtube_video_search"] is False


def test_settings_masks_openrouter_key(client):
    patched = client.patch(
        "/api/settings",
        json={"ai": {"openrouter_api_key": "sk-or-v1-abcdefghijklmnop"}},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["ai"]["openrouter_api_key_set"] is True
    assert body["ai"]["openrouter_api_key"].startswith("••••")
    assert "abcdefghijklmnop" not in body["ai"]["openrouter_api_key"]

    # Masked placeholder must not overwrite the stored key.
    client.patch(
        "/api/settings",
        json={"ai": {"openrouter_api_key": "••••nop"}},
    )
    still = client.get("/api/settings").json()
    assert still["ai"]["openrouter_api_key_set"] is True


def test_settings_persists_custom_css(client):
    css = ":root { --accent: 255 120 40; }"
    patched = client.patch(
        "/api/settings",
        json={"ui": {"custom_css": css, "custom_css_enabled": True}},
    )
    assert patched.status_code == 200
    assert patched.json()["ui"]["custom_css"] == css
    assert patched.json()["ui"]["custom_css_enabled"] is True
    again = client.get("/api/settings").json()
    assert again["ui"]["custom_css"] == css
    assert again["ui"]["custom_css_enabled"] is True


def test_settings_rejects_out_of_range_expiry(client):
    resp = client.patch("/api/settings", json={"progress_expiry_days": 0})
    assert resp.status_code == 422


def test_settings_setup_completed_patch_true_only(client):
    denied = client.patch("/api/settings", json={"setup_completed": False})
    assert denied.status_code == 400
    assert client.get("/api/settings").json()["setup_completed"] is False

    ok = client.patch("/api/settings", json={"setup_completed": True})
    assert ok.status_code == 200
    assert ok.json()["setup_completed"] is True
    assert client.get("/api/settings").json()["setup_completed"] is True


def test_settings_grandfathers_existing_file(client, tmp_dirs):
    path = tmp_dirs["data"] / "app_settings.json"
    path.write_text('{"progress_expiry_days": 14, "ui": {"theme": "oled"}}')
    body = client.get("/api/settings").json()
    assert body["setup_completed"] is True
    assert body["ui"]["theme"] == "oled"


# --- per-user preferences ----------------------------------------------------


def test_ui_preferences_are_private_to_each_user(client, member_client):
    assert (
        client.patch("/api/settings", json={"ui": {"theme": "oled"}}).status_code == 200
    )
    assert (
        member_client.patch(
            "/api/settings", json={"ui": {"theme": "nord", "fontSize": "large"}}
        ).status_code
        == 200
    )
    assert client.get("/api/settings").json()["ui"]["theme"] == "oled"
    mine = member_client.get("/api/settings").json()["ui"]
    assert (mine["theme"], mine["fontSize"]) == ("nord", "large")
    assert "fontSize" not in client.get("/api/settings").json()["ui"]


def test_ui_patch_merges_into_the_users_own_blob(member_client):
    member_client.patch("/api/settings", json={"ui": {"theme": "nord"}})
    member_client.patch("/api/settings", json={"ui": {"fontSize": "large"}})
    ui = member_client.get("/api/settings").json()["ui"]
    assert (ui["theme"], ui["fontSize"]) == ("nord", "large")


def test_server_wide_ui_blob_is_the_default_for_people_without_choices(
    init_db, client, member_client
):
    from app.services import app_settings

    app_settings.save({"ui": {"theme": "terminal", "fontSize": "xl"}})
    assert member_client.get("/api/settings").json()["ui"]["theme"] == "terminal"
    member_client.patch("/api/settings", json={"ui": {"theme": "mocha"}})
    ui = member_client.get("/api/settings").json()["ui"]
    assert (ui["theme"], ui["fontSize"]) == ("mocha", "xl")


def test_members_cannot_change_server_settings(member_client, client):
    for body in (
        {"progress_expiry_days": 30},
        {"ai": {"enabled": False}},
        {"setup_completed": True},
        {"ui": {"theme": "oled"}, "channel_catalog_enabled": False},
    ):
        resp = member_client.patch("/api/settings", json=body)
        assert resp.status_code == 403, body
        assert resp.json()["code"] == "admin_required"
    # The refused mixed request did not apply its ui half either.
    assert "theme" not in member_client.get("/api/settings").json()["ui"]
    assert client.get("/api/settings").json()["progress_expiry_days"] == 14


def test_server_owned_ui_keys_are_shared_and_admin_only(client, member_client):
    resp = client.patch(
        "/api/settings",
        json={"ui": {"download_video_codec": "sidecar", "theme": "oled"}},
    )
    assert resp.status_code == 200
    # A member cannot change them, and nothing in the refused request is applied.
    for key, value in (
        ("download_video_codec", "av1"),
        ("compat_copy_resolution", "source"),
    ):
        resp = member_client.patch(
            "/api/settings", json={"ui": {key: value, "theme": "mocha"}}
        )
        assert resp.status_code == 403, key
        assert resp.json()["code"] == "admin_required"
    # Echoing the current values (an older client saving its whole blob) is fine.
    resp = member_client.patch(
        "/api/settings",
        json={
            "ui": {
                "download_video_codec": "sidecar",
                "compat_copy_resolution": "1080p",
                "theme": "nord",
            }
        },
    )
    assert resp.status_code == 200
    for c, theme in ((client, "oled"), (member_client, "nord")):
        ui = c.get("/api/settings").json()["ui"]
        assert ui["download_video_codec"] == "sidecar"
        assert ui["theme"] == theme
    from app.services.ytdlp_formats import default_download_video_codec

    assert default_download_video_codec() == "sidecar"


# --- What a member may see of the AI setup -------------------------------------------


def _configure_ai_provider() -> None:
    from app.services import app_settings

    app_settings.save(
        {
            "ai": {
                "openrouter_enabled": True,
                "openrouter_api_key": "sk-or-v1-secret-tail-9f3a",
                "openrouter_model": "vendor/private-model",
                "openrouter_weekly_budget_usd": 7.5,
                "base_url": "http://gpu-box.internal:11434",
                "ai_chat": False,
                "ai_chapters_mode": "on_watch",
                "openrouter_show_costs": True,
                "schedule": "timer",
                "workload_profile": "light",
            }
        }
    )


def test_a_member_gets_the_ai_switches_but_not_the_provider_setup(
    client, member_client
):
    _configure_ai_provider()

    seen = member_client.get("/api/settings").json()["ai"]

    assert seen["openrouter_enabled"] is True
    assert seen["openrouter_api_key_set"] is True
    assert seen["ai_chat"] is False
    assert seen["ai_chapters_mode"] == "on_watch"
    assert seen["openrouter_show_costs"] is True
    assert seen["openrouter_api_key"] == ""
    assert seen["base_url"] == ""
    assert seen["openrouter_model"] != "vendor/private-model"
    assert seen["openrouter_weekly_budget_usd"] is None
    # An administrator still sees everything the Settings page edits.
    admin = client.get("/api/settings").json()["ai"]
    assert admin["openrouter_api_key"].endswith("9f3a")
    assert admin["base_url"] == "http://gpu-box.internal:11434"
    assert admin["openrouter_model"] == "vendor/private-model"
    assert admin["openrouter_weekly_budget_usd"] == 7.5


def test_a_members_settings_patch_does_not_echo_the_provider_setup(member_client):
    _configure_ai_provider()

    out = member_client.patch("/api/settings", json={"ui": {"theme": "oled"}}).json()

    assert out["ai"]["openrouter_api_key"] == ""
    assert out["ai"]["base_url"] == ""


def test_ai_status_hides_provider_internals_from_a_member(client, member_client):
    _configure_ai_provider()

    seen = member_client.get("/api/ai/status")
    full = client.get("/api/ai/status")

    assert seen.status_code == full.status_code == 200
    member, admin = seen.json(), full.json()
    # Everything the library and player read stays.
    assert member["openrouter_enabled"] is True
    assert member["openrouter_api_key_set"] is True
    assert {"ready", "enabled", "paused", "queue_depth"} <= member.keys()
    assert member["openrouter_model"] == ""
    assert member["base_url"] is None and member["last_error"] is None
    assert member["recent_failures"] == []
    assert member["pulling"] == [] and member["blocked_reason"] is None
    assert member["llm_backend"] is None and member["embed_backend"] is None
    # How the provider is set up, and the GPU, are the administrator's business.
    assert member["provider"] == ""
    assert member["schedule"] == "on_download"
    assert member["workload_profile"] == member["recommended_profile"] == "normal"
    assert member["profile_locked"] is False
    assert member["vram_tier"] == member["gpu_source"] == "unknown"
    assert member["openrouter_reachable"] is False
    assert admin["openrouter_model"] == "vendor/private-model"
    assert admin["provider"] != ""
    assert admin["schedule"] == "timer"
    assert admin["workload_profile"] == "light"


def test_health_hides_provider_internals_from_a_member(client, member_client):
    _configure_ai_provider()

    seen = member_client.get("/api/health").json()
    full = client.get("/api/health").json()

    # No member screen shows the OpenRouter status; it is set up by the admin.
    assert seen["openrouter"] is None
    assert seen["ollama"]["base_url"] is None
    assert seen["ollama"]["last_error"] is None
    assert not seen["ollama"]["pulling"]
    assert full["openrouter"]["model"] == "vendor/private-model"
    assert full["openrouter"]["enabled"] is True
    assert full["openrouter"]["configured"] is True


def test_the_ai_job_list_is_for_administrators(client, member_client):
    assert client.get("/api/ai/jobs").status_code == 200
    denied = member_client.get("/api/ai/jobs")
    assert denied.status_code == 403
    assert denied.json()["code"] == "admin_required"


def test_a_member_gets_the_defaults_of_the_server_only_fields(client, member_client):
    changed = {
        "metadata_sync_interval_hours": 72,
        "channel_catalog_enabled": False,
        "channel_catalog_max_videos": 3000,
        "direct_youtube_search": False,
        "youtube_video_search": False,
        "progress_expiry_days": 30,
    }
    assert client.patch("/api/settings", json=changed).status_code == 200
    admin = client.get("/api/settings").json()
    assert {k: admin[k] for k in changed} == changed

    for resp in (
        member_client.get("/api/settings"),
        member_client.patch("/api/settings", json={"ui": {"theme": "nord"}}),
    ):
        seen = resp.json()
        assert seen["metadata_sync_interval_hours"] == 24
        assert seen["channel_catalog_enabled"] is True
        assert seen["channel_catalog_max_videos"] == 1000
        # Member screens read these, so they are the real values.
        assert seen["direct_youtube_search"] is False
        assert seen["youtube_video_search"] is False
        assert seen["progress_expiry_days"] == 30
