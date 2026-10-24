"""Upgrading the pre-2 AI settings (Ollama + optional OpenRouter) to one connection.

Existing installs must keep working without being reconfigured, and keep their
model ids so stored embeddings still match.
"""

import json

import pytest

from app.services import app_settings as settings_svc
from app.services.ai import provider

OR_URL = "https://openrouter.ai/api/v1"


def _migrate(**legacy):
    return settings_svc._merge_ai(legacy)


def test_openrouter_for_chat_keeps_ollama_for_embeddings():
    ai = _migrate(
        enabled=True,
        provider="ollama",
        base_url="http://192.168.1.50:11434",
        embed_model="nomic-embed-text",
        chat_model="llama3.2:3b",
        openrouter_enabled=True,
        openrouter_api_key="sk-or-v1-secret",
        openrouter_model="google/gemini-2.5-flash",
        openrouter_scope="specialized",
    )
    assert ai["enabled"] is True
    assert ai["base_url"] == OR_URL
    assert ai["api_key"] == "sk-or-v1-secret"
    assert ai["chat_model"] == "google/gemini-2.5-flash"
    assert ai["embed_base_url"] == "http://192.168.1.50:11434/v1"
    assert ai["embed_api_key"] == ""
    assert ai["embed_model"] == "nomic-embed-text"
    assert ai["autodetect_ollama"] == ""
    assert ai["connection_version"] == 2
    for gone in ("openrouter_api_key", "openrouter_scope", "provider"):
        assert gone not in ai


def test_openrouter_for_everything():
    ai = _migrate(
        enabled=False,
        openrouter_enabled=True,
        openrouter_api_key="sk-or-v1-secret",
        openrouter_model="",
        openrouter_scope="all",
        openrouter_embed_model="openai/text-embedding-3-large",
        openrouter_show_costs=True,
        openrouter_weekly_budget_usd=5,
        openrouter_budget_hard_limit=True,
    )
    assert ai["enabled"] is True
    assert ai["base_url"] == OR_URL
    assert ai["chat_model"] == "google/gemini-2.5-flash-lite"
    assert ai["embed_base_url"] == ""
    assert ai["embed_model"] == "openai/text-embedding-3-large"
    assert ai["show_costs"] is True
    assert ai["weekly_budget_usd"] == 5.0
    assert ai["budget_hard_limit"] is True


def test_openrouter_all_with_prefer_ollama_embeds_on_ollama():
    ai = _migrate(
        base_url="http://gpu:11434/",
        openrouter_enabled=True,
        openrouter_api_key="k",
        openrouter_scope="all",
        ollama_prefer_embeddings=True,
    )
    assert ai["embed_base_url"] == "http://gpu:11434/v1"
    assert ai["embed_model"] == "nomic-embed-text"


def test_openrouter_with_ollama_off_has_no_embeddings():
    """Before, scope "specialized" with Ollama disabled meant no vectors at all."""
    ai = _migrate(
        enabled=False,
        openrouter_enabled=True,
        openrouter_api_key="k",
        openrouter_scope="specialized",
    )
    assert ai["enabled"] is True
    assert ai["embed_model"] == ""


def test_openrouter_key_from_the_environment_counts(monkeypatch):
    monkeypatch.setattr("app.config.OPENROUTER_API_KEY", "sk-env")
    ai = _migrate(enabled=False, openrouter_enabled=True, openrouter_api_key="")
    assert ai["base_url"] == OR_URL
    assert ai["api_key"] == ""


def test_ollama_only_keeps_its_models():
    ai = _migrate(
        base_url="http://ollama:11434",
        embed_model="mxbai-embed-large",
        chat_model="qwen2.5:7b",
    )
    assert ai["enabled"] is True
    assert ai["base_url"] == "http://ollama:11434/v1"
    assert ai["chat_model"] == "qwen2.5:7b"
    assert ai["embed_model"] == "mxbai-embed-large"
    assert ai["embed_base_url"] == ""


def test_ollama_auto_discovery_is_left_for_startup(monkeypatch):
    monkeypatch.setattr("app.config.OLLAMA_BASE_URL", "")
    ai = _migrate(enabled=True, provider="ollama", base_url="")
    assert ai["base_url"] == ""
    assert ai["autodetect_ollama"] == "chat"
    assert ai["chat_model"] == "llama3.2:3b"


def test_ollama_url_from_the_environment(monkeypatch):
    monkeypatch.setattr("app.config.OLLAMA_BASE_URL", "http://10.0.0.9:11434")
    ai = _migrate(enabled=True, base_url="")
    assert ai["base_url"] == "http://10.0.0.9:11434/v1"
    assert ai["autodetect_ollama"] == ""


def test_everything_off_stays_off():
    ai = _migrate(enabled=False, openrouter_enabled=False, base_url="http://x:11434")
    assert ai["enabled"] is False
    assert ai["autodetect_ollama"] == ""


def test_new_settings_are_not_migrated_again():
    current = settings_svc._merge_ai({})
    current.update(base_url="https://api.openai.com/v1", chat_model="gpt-4.1-mini")
    assert settings_svc._merge_ai(current) == current


def test_the_migration_reaches_the_file_on_the_next_save(tmp_dirs):
    path = tmp_dirs["data"] / "app_settings.json"
    path.write_text(
        json.dumps(
            {
                "setup_completed": True,
                "ai": {
                    "openrouter_enabled": True,
                    "openrouter_api_key": "sk-or-v1-secret",
                    "openrouter_scope": "all",
                },
            }
        )
    )
    assert settings_svc.ai_settings()["base_url"] == OR_URL

    settings_svc.save({"ai": {"paused": True}})

    stored = json.loads(path.read_text())["ai"]
    assert stored["connection_version"] == 2
    assert stored["base_url"] == OR_URL
    assert stored["api_key"] == "sk-or-v1-secret"
    assert stored["paused"] is True
    assert "openrouter_api_key" not in stored


@pytest.mark.parametrize("target", ["chat", "embed"])
def test_startup_fills_in_the_discovered_ollama_address(tmp_dirs, monkeypatch, target):
    settings_svc.save({"ai": {"autodetect_ollama": target}})
    monkeypatch.setattr(
        provider,
        "detect_local_servers",
        lambda: [
            {"label": "LM Studio", "base_url": "http://127.0.0.1:1234/v1", "kind": "x"},
            {
                "label": "Ollama",
                "base_url": "http://host.docker.internal:11434/v1",
                "kind": "ollama",
            },
        ],
    )

    provider.finish_legacy_ollama_detect()

    ai = settings_svc.ai_settings()
    field = "base_url" if target == "chat" else "embed_base_url"
    assert ai[field] == "http://host.docker.internal:11434/v1"
    assert ai["autodetect_ollama"] == ""


def test_startup_keeps_looking_when_no_ollama_answers(tmp_dirs, monkeypatch):
    settings_svc.save({"ai": {"autodetect_ollama": "chat"}})
    monkeypatch.setattr(provider, "detect_local_servers", list)

    provider.finish_legacy_ollama_detect()

    assert settings_svc.ai_settings()["autodetect_ollama"] == "chat"


def test_embeddings_wait_while_their_ollama_is_not_found(tmp_dirs, monkeypatch):
    """Not falling back to the chat endpoint: that would send Ollama model ids
    (and the OpenRouter key) to OpenRouter."""
    monkeypatch.setattr("app.config.OLLAMA_BASE_URL", "")
    path = tmp_dirs["data"] / "app_settings.json"
    path.write_text(
        json.dumps(
            {
                "setup_completed": True,
                "ai": {
                    "openrouter_enabled": True,
                    "openrouter_api_key": "sk-or-v1-secret",
                    "openrouter_scope": "specialized",
                    "base_url": "",
                },
            }
        )
    )
    assert settings_svc.ai_settings()["autodetect_ollama"] == "embed"

    assert provider.embed_connection() is None
    assert provider.chat_connection() is not None


def test_setting_a_url_ends_the_ollama_search(client, monkeypatch):
    settings_svc.save({"ai": {"autodetect_ollama": "chat"}})

    client.patch(
        "/api/settings",
        json={"ai": {"base_url": OR_URL, "api_key": "sk-or-v1-secret"}},
    )
    assert settings_svc.ai_settings()["autodetect_ollama"] == ""

    # Even with the flag back, a URL the admin set is never overwritten.
    settings_svc.save({"ai": {"autodetect_ollama": "chat"}})
    monkeypatch.setattr(
        provider,
        "detect_local_servers",
        lambda: [
            {"label": "Ollama", "base_url": "http://ollama:11434/v1", "kind": "ollama"}
        ],
    )
    provider.finish_legacy_ollama_detect()
    ai = settings_svc.ai_settings()
    assert ai["base_url"] == OR_URL
    assert ai["api_key"] == "sk-or-v1-secret"
    assert ai["autodetect_ollama"] == ""
