"""HTTP regression: settings persist without touching live AI providers."""


def test_settings_get_defaults_and_patch_roundtrip(client):
    first = client.get("/api/settings")
    assert first.status_code == 200
    body = first.json()
    assert body["progress_expiry_days"] == 14
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
