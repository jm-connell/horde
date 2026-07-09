"""LLM / embedding provider abstraction.

Ollama is the only implementation today. Settings store ``provider: "ollama"``
so a future OpenRouter (or similar) backend can plug in without rewriting
search / tags / recommendations.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

import httpx

from ...config import OLLAMA_BASE_URL
from .. import app_settings

logger = logging.getLogger(__name__)

# Prefer localhost first outside Docker — Docker DNS names hang on Windows/macOS
# host networking and were stalling /api/health (and thus dev.bat).
_AUTO_CANDIDATES = (
    "http://127.0.0.1:11434",
    "http://host.docker.internal:11434",
    "http://ollama:11434",
)

# Keep discovery snappy — long timeouts block /api/health and stall dev.bat.
_DISCOVER_TIMEOUT = httpx.Timeout(0.35, connect=0.25)
_NEGATIVE_CACHE_SEC = 30.0

_pull_lock = threading.Lock()
_pulling: set[str] = set()
_last_error: Optional[str] = None
_resolved_url: Optional[str] = None
_resolve_failed_at: float = 0.0
_model_cache: dict[str, tuple[float, bool, bool]] = {}
_MODEL_CACHE_SEC = 30.0


@dataclass
class ProviderStatus:
    enabled: bool
    provider: str
    ready: bool
    reachable: bool
    base_url: Optional[str]
    embed_model: str
    chat_model: str
    embed_model_present: bool
    chat_model_present: bool
    pulling: list[str] = field(default_factory=list)
    last_error: Optional[str] = None
    paused: bool = False
    schedule: str = "on_download"
    indexed_videos: int = 0
    total_videos: int = 0
    queue_depth: int = 0


class EmbedProvider(Protocol):
    def embed(self, text: str, model: str) -> list[float]: ...


class LlmProvider(Protocol):
    def chat(self, prompt: str, model: str, *, system: Optional[str] = None) -> str: ...


class OllamaProvider:
    def __init__(self, base_url: str, timeout: float | httpx.Timeout = 120.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=self.base_url, timeout=self.timeout)

    def ping(self) -> bool:
        try:
            # /api/version is cheaper than /api/tags (no model list).
            with self._client() as client:
                resp = client.get("/api/version")
                if resp.is_success:
                    return True
                resp = client.get("/api/tags")
                return resp.is_success
        except Exception:  # noqa: BLE001
            return False

    def list_models(self) -> list[str]:
        with self._client() as client:
            resp = client.get("/api/tags")
            resp.raise_for_status()
            data = resp.json()
        names: list[str] = []
        for row in data.get("models") or []:
            name = row.get("name") or row.get("model")
            if name:
                names.append(str(name))
        return names

    def has_model(self, model: str) -> bool:
        want = model.strip().lower().split(":")[0]
        if not want:
            return False
        for name in self.list_models():
            base = name.lower().split(":")[0]
            if base == want:
                return True
        return False

    def pull_model(self, model: str) -> None:
        global _last_error
        with _pull_lock:
            if model in _pulling:
                return
            _pulling.add(model)
        try:
            with self._client() as client:
                # stream=false waits until pull completes; may take a while.
                resp = client.post(
                    "/api/pull",
                    json={"name": model, "stream": False},
                    timeout=600.0,
                )
                resp.raise_for_status()
            _last_error = None
        except Exception as exc:  # noqa: BLE001
            _last_error = f"Failed to pull {model}: {exc}"
            logger.warning(_last_error)
            raise
        finally:
            with _pull_lock:
                _pulling.discard(model)

    def embed(self, text: str, model: str) -> list[float]:
        global _last_error
        payload = {"model": model, "prompt": text}
        try:
            with self._client() as client:
                resp = client.post("/api/embeddings", json=payload)
                resp.raise_for_status()
                data = resp.json()
            vec = data.get("embedding")
            if not isinstance(vec, list) or not vec:
                raise RuntimeError("Ollama returned empty embedding")
            _last_error = None
            return [float(x) for x in vec]
        except Exception as exc:  # noqa: BLE001
            _last_error = str(exc)
            raise

    def chat(
        self, prompt: str, model: str, *, system: Optional[str] = None
    ) -> str:
        global _last_error
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.2},
        }
        try:
            with self._client() as client:
                resp = client.post("/api/chat", json=payload)
                resp.raise_for_status()
                data = resp.json()
            content = (data.get("message") or {}).get("content") or ""
            _last_error = None
            return str(content)
        except Exception as exc:  # noqa: BLE001
            _last_error = str(exc)
            raise


def _settings_url() -> str:
    ai = app_settings.ai_settings()
    configured = (ai.get("base_url") or "").strip()
    if configured:
        return configured
    if OLLAMA_BASE_URL:
        return OLLAMA_BASE_URL
    return ""


def resolve_base_url(*, force: bool = False) -> Optional[str]:
    """Return a reachable Ollama base URL, or None."""
    global _resolved_url, _last_error, _resolve_failed_at
    if not force and _resolved_url:
        # Trust a previously resolved URL without re-pinging every call.
        # Callers that need a fresh check can pass force=True.
        return _resolved_url

    if (
        not force
        and _resolve_failed_at
        and (time.monotonic() - _resolve_failed_at) < _NEGATIVE_CACHE_SEC
    ):
        return None

    candidates: list[str] = []
    preferred = _settings_url()
    if preferred:
        candidates.append(preferred)
    # Inside Docker, try the compose service name earlier.
    in_docker = os.path.exists("/.dockerenv")
    auto = (
        (
            "http://ollama:11434",
            "http://host.docker.internal:11434",
            "http://127.0.0.1:11434",
        )
        if in_docker
        else _AUTO_CANDIDATES
    )
    for url in auto:
        if url not in candidates:
            candidates.append(url)

    for url in candidates:
        if OllamaProvider(url, timeout=_DISCOVER_TIMEOUT).ping():
            _resolved_url = url
            _last_error = None
            _resolve_failed_at = 0.0
            return url

    _last_error = "Ollama not reachable"
    _resolved_url = None
    _resolve_failed_at = time.monotonic()
    return None


def get_provider() -> Optional[OllamaProvider]:
    ai = app_settings.ai_settings()
    if not ai.get("enabled", True):
        return None
    if (ai.get("provider") or "ollama") != "ollama":
        # Future providers (OpenRouter, etc.) plug in here.
        return None
    url = resolve_base_url()
    if not url:
        return None
    return OllamaProvider(url)


def ensure_models(provider: OllamaProvider) -> tuple[bool, bool]:
    """Ensure embed/chat models exist; kick off pulls if configured.

    Returns (embed_present, chat_present).
    """
    ai = app_settings.ai_settings()
    embed_model = str(ai.get("embed_model") or "nomic-embed-text")
    chat_model = str(ai.get("chat_model") or "llama3.2:3b")
    embed_ok = provider.has_model(embed_model)
    chat_ok = provider.has_model(chat_model)
    if ai.get("auto_pull_models", True):
        for model, ok in ((embed_model, embed_ok), (chat_model, chat_ok)):
            if ok:
                continue
            with _pull_lock:
                already = model in _pulling
            if already:
                continue

            def _pull(m: str = model) -> None:
                try:
                    provider.pull_model(m)
                except Exception:  # noqa: BLE001
                    pass

            threading.Thread(target=_pull, daemon=True).start()
    return embed_ok, chat_ok


def pulling_models() -> list[str]:
    with _pull_lock:
        return sorted(_pulling)


def last_error() -> Optional[str]:
    return _last_error


def invalidate_resolved_url() -> None:
    global _resolved_url, _resolve_failed_at, _model_cache
    _resolved_url = None
    _resolve_failed_at = 0.0
    _model_cache.clear()


def _cached_model_presence(
    provider: OllamaProvider, embed_model: str, chat_model: str, *, pull: bool
) -> tuple[bool, bool]:
    """Return (embed_ok, chat_ok), using a short cache to keep status cheap."""
    cache_key = f"{provider.base_url}|{embed_model}|{chat_model}"
    now = time.monotonic()
    cached = _model_cache.get(cache_key)
    if cached and (now - cached[0]) < _MODEL_CACHE_SEC:
        return cached[1], cached[2]

    if pull:
        embed_ok, chat_ok = ensure_models(provider)
    else:
        try:
            embed_ok = provider.has_model(embed_model)
            chat_ok = provider.has_model(chat_model)
        except Exception as exc:  # noqa: BLE001
            global _last_error
            _last_error = str(exc)
            embed_ok, chat_ok = False, False
    _model_cache[cache_key] = (now, embed_ok, chat_ok)
    return embed_ok, chat_ok


def build_status(
    *,
    indexed_videos: int = 0,
    total_videos: int = 0,
    queue_depth: int = 0,
    quick: bool = False,
) -> ProviderStatus:
    """Build provider status.

    ``quick=True`` skips model pulls and uses short timeouts / caches so it is
    safe for ``/api/health`` (dev.bat waits on that endpoint with a 1s timeout).
    """
    global _last_error
    ai = app_settings.ai_settings()
    embed_model = str(ai.get("embed_model") or "nomic-embed-text")
    chat_model = str(ai.get("chat_model") or "llama3.2:3b")
    enabled = bool(ai.get("enabled", True))
    provider_name = str(ai.get("provider") or "ollama")

    if not enabled:
        return ProviderStatus(
            enabled=False,
            provider=provider_name,
            ready=False,
            reachable=False,
            base_url=_settings_url() or None,
            embed_model=embed_model,
            chat_model=chat_model,
            embed_model_present=False,
            chat_model_present=False,
            pulling=[],
            last_error=None,
            paused=bool(ai.get("paused")),
            schedule=str(ai.get("schedule") or "on_download"),
            indexed_videos=indexed_videos,
            total_videos=total_videos,
            queue_depth=queue_depth,
        )

    url = resolve_base_url()
    reachable = url is not None
    embed_ok = False
    chat_ok = False
    if url:
        try:
            provider = OllamaProvider(url, timeout=2.0 if quick else 5.0)
            embed_ok, chat_ok = _cached_model_presence(
                provider,
                embed_model,
                chat_model,
                pull=not quick and bool(ai.get("auto_pull_models", True)),
            )
        except Exception as exc:  # noqa: BLE001
            _last_error = str(exc)
            reachable = False

    ready = reachable and embed_ok  # chat optional for search/related
    return ProviderStatus(
        enabled=True,
        provider=provider_name,
        ready=ready,
        reachable=reachable,
        base_url=url,
        embed_model=embed_model,
        chat_model=chat_model,
        embed_model_present=embed_ok,
        chat_model_present=chat_ok,
        pulling=pulling_models(),
        last_error=_last_error,
        paused=bool(ai.get("paused")),
        schedule=str(ai.get("schedule") or "on_download"),
        indexed_videos=indexed_videos,
        total_videos=total_videos,
        queue_depth=queue_depth,
    )


def test_connection(base_url: Optional[str] = None) -> dict[str, Any]:
    """Probe a URL (or auto-discover) and return a status dict for Settings."""
    invalidate_resolved_url()
    if base_url and base_url.strip():
        url = base_url.strip().rstrip("/")
        provider = OllamaProvider(url, timeout=5.0)
        if not provider.ping():
            return {"ok": False, "base_url": url, "detail": "Unreachable"}
        try:
            models = provider.list_models()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "base_url": url, "detail": str(exc)}
        return {"ok": True, "base_url": url, "models": models}

    url = resolve_base_url(force=True)
    if not url:
        return {"ok": False, "base_url": None, "detail": "Ollama not reachable"}
    provider = OllamaProvider(url, timeout=5.0)
    try:
        models = provider.list_models()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "base_url": url, "detail": str(exc)}
    return {"ok": True, "base_url": url, "models": models}
