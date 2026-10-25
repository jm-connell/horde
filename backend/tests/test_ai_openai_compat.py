"""Any OpenAI-compatible endpoint serves chat and embeddings.

The fake servers below answer the OpenAI routes (and Ollama's native ones where
a test needs an Ollama host) through httpx's MockTransport.
"""

import json

import httpx
from sqlmodel import select

from app.models import OpenRouterUsage
from app.services import app_settings
from app.services.ai import provider

OR_URL = "https://openrouter.ai/api/v1"


class FakeServer:
    """Records requests; ``ollama_hosts`` also answer Ollama's ``/api/*``."""

    def __init__(self, *, ollama_hosts=(), installed=(), cost=None):
        self.requests: list[httpx.Request] = []
        self.ollama_hosts = set(ollama_hosts)
        self.installed = list(installed)
        self.cost = cost

    def body(self, path: str) -> dict:
        req = next(r for r in self.requests if r.url.path == path)
        return json.loads(req.content)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path in ("/api/version", "/api/tags", "/api/pull"):
            if request.url.host not in self.ollama_hosts:
                return httpx.Response(404)
            if path == "/api/version":
                return httpx.Response(200, json={"version": "0.40.5"})
            if path == "/api/tags":
                return httpx.Response(
                    200, json={"models": [{"name": m} for m in self.installed]}
                )
            return httpx.Response(200, json={"status": "success"})
        if path.endswith("/models"):
            return httpx.Response(
                200, json={"data": [{"id": "chat-a"}, {"id": "text-embed-b"}]}
            )
        usage: dict = {"prompt_tokens": 3, "completion_tokens": 2}
        if self.cost is not None:
            usage["cost"] = self.cost
        if path.endswith("/chat/completions"):
            return httpx.Response(
                200,
                json={
                    "choices": [{"message": {"content": "hello"}}],
                    "usage": usage,
                },
            )
        if path.endswith("/embeddings"):
            payload = json.loads(request.content)
            n = len(payload["input"]) if isinstance(payload["input"], list) else 1
            return httpx.Response(
                200,
                json={
                    "data": [{"index": i, "embedding": [0.1, 0.2]} for i in range(n)],
                    "usage": usage,
                },
            )
        return httpx.Response(404)


def _configure(**ai):
    app_settings.save({"ai": ai})


def test_chat_uses_the_plain_openai_api(session, serve_ai):
    server = FakeServer()
    serve_ai(server)
    _configure(base_url="http://lmstudio.lan:1234", api_key="k", chat_model="chat-a")

    llm = provider.get_llm_provider()
    assert llm is not None
    assert llm.chat("hi", provider.resolve_llm_model(), format=None) == "hello"

    req = next(r for r in server.requests if r.url.path == "/v1/chat/completions")
    assert str(req.url).startswith("http://lmstudio.lan:1234/v1/")
    assert req.headers["Authorization"] == "Bearer k"
    assert "X-Title" not in req.headers
    body = json.loads(req.content)
    assert body["model"] == "chat-a"
    # OpenRouter-only fields would make strict servers (OpenAI) reject the call.
    assert "usage" not in body


def test_openrouter_reports_cost_into_the_ledger(session, serve_ai):
    server = FakeServer(cost=0.0012)
    serve_ai(server)
    _configure(base_url=OR_URL, api_key="sk-or", chat_model="google/x")

    llm = provider.get_llm_provider()
    assert llm is not None
    llm.chat("hi", "google/x", usage_kind="summary")

    assert server.body("/api/v1/chat/completions")["usage"] == {"include": True}
    assert provider.build_status().reports_cost is True
    rows = session.exec(select(OpenRouterUsage)).all()
    assert [(r.kind, r.cost) for r in rows] == [("summary", 0.0012)]


def test_embeddings_can_use_their_own_endpoint(session, serve_ai):
    server = FakeServer()
    serve_ai(server)
    _configure(
        base_url=OR_URL,
        api_key="sk-or-secret",
        chat_model="google/x",
        embed_base_url="http://gpu.lan:11434",
        embed_model="nomic-embed-text",
    )

    embedder = provider.get_embed_provider()
    assert embedder is not None
    assert embedder.embed_many(["a", "b"], provider.resolve_embed_model()) == [
        [0.1, 0.2],
        [0.1, 0.2],
    ]

    req = next(r for r in server.requests if r.url.path == "/v1/embeddings")
    assert req.url.host == "gpu.lan"
    # The chat endpoint's key is never sent to the embeddings host.
    assert "Authorization" not in req.headers


def test_no_embed_model_means_no_embeddings(session, serve_ai):
    serve_ai(FakeServer())
    _configure(base_url=OR_URL, chat_model="google/x", embed_model="")
    assert provider.get_embed_provider() is None
    assert provider.embeddings_configured() is False


def test_unreachable_endpoint_is_reported_not_raised(session):
    _configure(base_url="http://down.lan:1234", chat_model="m", embed_model="e")

    assert provider.get_llm_provider() is None
    status = provider.build_status()
    assert status.configured is True
    assert status.reachable is False and status.ready is False
    assert provider.llm_configured() is True


def test_status_knows_an_ollama_host_and_its_missing_models(session, serve_ai):
    serve_ai(FakeServer(ollama_hosts={"ollama"}, installed=["nomic-embed-text:latest"]))
    _configure(
        base_url="http://ollama:11434/v1",
        chat_model="qwen2.5:7b",
        embed_model="nomic-embed-text",
        auto_pull_models=False,
    )

    status = provider.build_status()

    assert status.provider == "ollama"
    assert status.reachable is True
    assert status.embed_model_present is True and status.ready is True
    assert status.chat_model_present is False
    llm = provider.get_llm_provider()
    assert llm is not None
    assert "not installed on Ollama" in (
        provider.require_llm_chat_model(llm, "qwen2.5:7b") or ""
    )


def test_ollama_model_download_uses_the_native_api(session, serve_ai):
    server = FakeServer(ollama_hosts={"ollama"})
    serve_ai(server)

    provider.OllamaAdmin("http://ollama:11434").pull_model("qwen2.5:7b")

    assert server.body("/api/pull") == {"name": "qwen2.5:7b", "stream": False}


def test_a_hosted_provider_is_not_probed_as_ollama(session, serve_ai):
    server = FakeServer()
    serve_ai(server)
    _configure(base_url="http://vllm.lan:8000", chat_model="chat-a")

    assert provider.build_status().provider == "openai_compatible"
    assert provider.connection_kind(provider.chat_connection()) == "openai_compatible"
    _configure(base_url=OR_URL)
    assert provider.build_status().provider == "openrouter"
    assert not any(
        r.url.path == "/api/version"
        for r in server.requests
        if r.url.host == "openrouter.ai"
    )


def test_test_endpoint_lists_models(client, serve_ai):
    serve_ai(FakeServer())

    body = client.post(
        "/api/ai/test", json={"base_url": "http://lmstudio.lan:1234"}
    ).json()

    assert body["ok"] is True
    assert body["base_url"] == "http://lmstudio.lan:1234/v1"
    assert body["kind"] == "openai_compatible"
    assert [m["id"] for m in body["models"]] == ["chat-a", "text-embed-b"]
    assert [m["id"] for m in body["embedding_models"]] == ["text-embed-b"]


def test_test_endpoint_sends_the_saved_key_only_to_the_saved_url(client, serve_ai):
    server = FakeServer()
    serve_ai(server)
    _configure(base_url=OR_URL, api_key="sk-or-secret", chat_model="google/x")

    assert client.post("/api/ai/test", json={}).json()["ok"] is True
    assert server.requests[-1].headers["Authorization"] == "Bearer sk-or-secret"

    # The form posts the masked key back while the URL points somewhere else.
    client.post(
        "/api/ai/test",
        json={"base_url": "http://other.lan:1234", "api_key": "••••cret"},
    )
    other = [r for r in server.requests if r.url.host == "other.lan"]
    assert other and all("Authorization" not in r.headers for r in other)


def test_detect_finds_a_local_ollama(client, serve_ai):
    def handler(request: httpx.Request) -> httpx.Response:
        if (request.url.host, request.url.port) != ("127.0.0.1", 11434):
            raise httpx.ConnectError("closed", request=request)
        return FakeServer(ollama_hosts={"127.0.0.1"})(request)

    serve_ai(handler)

    servers = client.post("/api/ai/detect").json()["servers"]

    assert {
        "label": "Ollama",
        "base_url": "http://127.0.0.1:11434/v1",
        "kind": "ollama",
    } in servers
    assert all(s["base_url"] == "http://127.0.0.1:11434/v1" for s in servers)


def test_the_budget_only_stops_openrouter(session, serve_ai, monkeypatch):
    import pytest

    from app.services.ai import cost_ledger

    serve_ai(FakeServer())
    monkeypatch.setattr(
        cost_ledger,
        "budget_status",
        lambda **_: {"blocked": True, "weekly_budget_usd": 1.0, "d7": 2.0},
    )

    local = provider.OpenAICompatProvider(
        provider.Connection("http://gpu.lan:11434/v1")
    )
    assert local.embed_many(["a"], "nomic-embed-text") == [[0.1, 0.2]]
    assert local.chat("hi", "llama3.2:3b", format=None) == "hello"

    hosted = provider.OpenAICompatProvider(provider.Connection(OR_URL, "k"))
    with pytest.raises(cost_ledger.OpenRouterBudgetExceeded):
        hosted.chat("hi", "google/x", format=None)


def test_embedding_models_come_from_the_embeddings_server(client, serve_ai):
    server = FakeServer()
    serve_ai(server)
    _configure(
        base_url=OR_URL,
        api_key="sk-or-secret",
        chat_model="google/x",
        embed_base_url="http://gpu.lan:11434/v1",
        embed_api_key="embed-key",
        embed_model="",
    )

    assert client.post("/api/ai/test", json={"target": "embed"}).json()["ok"]

    listed = [r for r in server.requests if r.url.path == "/v1/models"]
    assert listed and all(r.url.host == "gpu.lan" for r in listed)
    assert listed[0].headers["Authorization"] == "Bearer embed-key"


def test_a_server_that_rejects_the_key_is_reachable_not_down(session, serve_ai):
    """Its jobs then fail with "rejected credentials" instead of waiting forever."""
    serve_ai(lambda request: httpx.Response(401))
    _configure(base_url="http://vllm.lan:8000", api_key="wrong", chat_model="m")

    assert provider.build_status().reachable is True
    # Finding servers on this machine still wants a real AI API.
    assert not provider.OpenAICompatProvider(
        provider.Connection("http://vllm.lan:8000/v1")
    ).ping(strict=True)
