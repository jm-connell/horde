from app.services.ai.provider import parse_openrouter_catalog_row, usd_per_million


def test_usd_per_million_from_openrouter_per_token():
    assert usd_per_million("0.0000001") == 0.1
    assert usd_per_million("0.0000004") == 0.4
    assert usd_per_million(0) == 0.0
    assert usd_per_million("") is None
    assert usd_per_million(None) is None
    assert usd_per_million("nope") is None
    assert usd_per_million(-1) is None


def test_parse_openrouter_catalog_row_includes_prices():
    row = parse_openrouter_catalog_row(
        {
            "id": "google/gemini-2.5-flash-lite",
            "name": "Google: Gemini 2.5 Flash Lite",
            "pricing": {"prompt": "0.0000001", "completion": "0.0000004"},
        }
    )
    assert row == {
        "id": "google/gemini-2.5-flash-lite",
        "name": "Google: Gemini 2.5 Flash Lite",
        "prompt_per_million": 0.1,
        "completion_per_million": 0.4,
    }


def test_parse_openrouter_catalog_row_without_pricing():
    row = parse_openrouter_catalog_row({"id": "openai/gpt-4.1-nano"})
    assert row["id"] == "openai/gpt-4.1-nano"
    assert row["name"] == "openai/gpt-4.1-nano"
    assert row["prompt_per_million"] is None
    assert row["completion_per_million"] is None


def test_parse_openrouter_catalog_row_skips_empty():
    assert parse_openrouter_catalog_row({}) is None
    assert parse_openrouter_catalog_row(None) is None
    assert parse_openrouter_catalog_row("x") is None


def test_openrouter_models_api_includes_prices(client, monkeypatch):
    monkeypatch.setattr(
        "app.api.ai.list_openrouter_models",
        lambda: [
            {
                "id": "google/gemini-2.5-flash-lite",
                "name": "Google: Gemini 2.5 Flash Lite",
                "prompt_per_million": 0.1,
                "completion_per_million": 0.4,
            }
        ],
    )
    monkeypatch.setattr("app.api.ai.list_openrouter_embedding_models", lambda: [])
    res = client.get("/api/ai/openrouter/models")
    assert res.status_code == 200
    row = res.json()["models"][0]
    assert row["id"] == "google/gemini-2.5-flash-lite"
    assert row["prompt_per_million"] == 0.1
    assert row["completion_per_million"] == 0.4
