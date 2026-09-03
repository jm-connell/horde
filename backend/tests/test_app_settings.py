"""Tests for settings clamps, merge, load/save, and API key masking."""

import json

import pytest

from app.services import app_settings as settings_svc
from app.services.ai.provider import mask_openrouter_api_key


def test_clamp_category_min_score():
    assert settings_svc.clamp_category_min_score(0.55) == 0.55
    assert settings_svc.clamp_category_min_score(0.0) == 0.20
    assert settings_svc.clamp_category_min_score(1.0) == 0.90
    assert settings_svc.clamp_category_min_score("nope") == 0.55


def test_clamp_tag_rescan_days():
    assert settings_svc.clamp_tag_rescan_days(90) == 90
    assert settings_svc.clamp_tag_rescan_days(1) == 7
    assert settings_svc.clamp_tag_rescan_days(9999) == 365
    assert settings_svc.clamp_tag_rescan_days("x") == 90


def test_clamp_vram_gb():
    assert settings_svc.clamp_vram_gb(None) is None
    assert settings_svc.clamp_vram_gb("") is None
    assert settings_svc.clamp_vram_gb(0) is None
    assert settings_svc.clamp_vram_gb("bad") is None
    assert settings_svc.clamp_vram_gb(8) == 8.0
    assert settings_svc.clamp_vram_gb(0.1) == 0.5
    assert settings_svc.clamp_vram_gb(9999) == 256.0


def test_clamp_weekly_budget_usd():
    assert settings_svc.clamp_weekly_budget_usd(None) is None
    assert settings_svc.clamp_weekly_budget_usd(0) is None
    assert settings_svc.clamp_weekly_budget_usd(float("nan")) is None
    assert settings_svc.clamp_weekly_budget_usd(5) == 5.0
    assert settings_svc.clamp_weekly_budget_usd(0.001) == 0.01


def test_clamp_catalog_max_videos():
    assert settings_svc.clamp_catalog_max_videos(1000) == 1000
    assert settings_svc.clamp_catalog_max_videos(1) == 100
    assert settings_svc.clamp_catalog_max_videos(99999) == 5000


def test_direct_youtube_search_effective():
    assert settings_svc.direct_youtube_search_effective(None, True) is True
    assert settings_svc.direct_youtube_search_effective(None, False) is False
    assert settings_svc.direct_youtube_search_effective(True, False) is True
    assert settings_svc.direct_youtube_search_effective(False, True) is False
    assert settings_svc.direct_youtube_search_effective(0, True) is False
    assert settings_svc.direct_youtube_search_effective(1, False) is True


def test_normalize_helpers():
    assert settings_svc.normalize_summary_length("long") == "long"
    assert settings_svc.normalize_summary_length("nope") == "short"
    assert settings_svc.normalize_openrouter_scope("all") == "all"
    assert settings_svc.normalize_openrouter_scope("weird") == "specialized"
    assert settings_svc.normalize_openrouter_embed_model("") == (
        settings_svc.AI_DEFAULTS["openrouter_embed_model"]
    )


def test_merge_ai_drops_unknown_and_clamps():
    merged = settings_svc._merge_ai(
        {"category_min_score": 0.01, "unknown_key": 1, "enabled": False}
    )
    assert "unknown_key" not in merged
    assert merged["category_min_score"] == 0.20
    assert merged["enabled"] is False


def test_load_missing_file_returns_defaults(tmp_dirs):
    data = settings_svc.load()
    assert data["progress_expiry_days"] == 14
    assert data["ai"]["embed_model"] == settings_svc.AI_DEFAULTS["embed_model"]


def test_load_corrupt_file_returns_defaults(tmp_dirs):
    path = tmp_dirs["data"] / "app_settings.json"
    path.write_text("{not json")
    data = settings_svc.load()
    assert data["ai"]["chat_model"] == settings_svc.AI_DEFAULTS["chat_model"]


def test_save_merges_ui_and_ai(tmp_dirs):
    settings_svc.save({"ui": {"theme": "oled"}, "ai": {"enabled": False}})
    settings_svc.save({"ui": {"fontSize": "large"}})
    data = settings_svc.load()
    assert data["ui"]["theme"] == "oled"
    assert data["ui"]["fontSize"] == "large"
    assert data["ai"]["enabled"] is False
    raw = json.loads((tmp_dirs["data"] / "app_settings.json").read_text())
    assert raw["ui"]["theme"] == "oled"


def test_openrouter_show_costs_defaults_false():
    merged = settings_svc._merge_ai({})
    assert merged["openrouter_show_costs"] is False
    on = settings_svc._merge_ai({"openrouter_show_costs": True})
    assert on["openrouter_show_costs"] is True


def test_mask_openrouter_api_key():
    assert mask_openrouter_api_key("") == ""
    assert mask_openrouter_api_key("abcd") == "••••"
    assert mask_openrouter_api_key("sk-or-v1-abcdefgh") == "••••efgh"
