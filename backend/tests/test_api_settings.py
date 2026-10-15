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
    # The SPA saves its whole blob, so a member's attempt is ignored, not refused.
    resp = member_client.patch(
        "/api/settings",
        json={"ui": {"download_video_codec": "av1", "theme": "nord"}},
    )
    assert resp.status_code == 200
    for c, theme in ((client, "oled"), (member_client, "nord")):
        ui = c.get("/api/settings").json()["ui"]
        assert ui["download_video_codec"] == "sidecar"
        assert ui["theme"] == theme
    from app.services.ytdlp_formats import default_download_video_codec

    assert default_download_video_codec() == "sidecar"
