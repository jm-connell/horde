"""LLM / embedding provider abstraction.

Ollama handles embeddings (and local LLM fallback). Optional OpenRouter covers
cloud LLM tasks: summaries, chat, tag enrich, and duplicate confirmation.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional, Protocol, Union

import httpx

from ...config import OLLAMA_BASE_URL, OPENROUTER_API_KEY
from .. import app_settings

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_PRESETS: dict[str, str] = {
    "budget": "google/gemini-2.5-flash-lite",
    "best": "google/gemini-2.5-flash",
}
OPENROUTER_DEFAULT_MODEL = OPENROUTER_PRESETS["budget"]

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
    openrouter_enabled: bool = False
    openrouter_reachable: bool = False
    openrouter_model: str = OPENROUTER_DEFAULT_MODEL
    openrouter_api_key_set: bool = False
    openrouter_scope: str = "specialized"
    openrouter_embed_model: str = "openai/text-embedding-3-small"
    ollama_prefer_embeddings: bool = False
    llm_backend: Optional[str] = None
    embed_backend: Optional[str] = None


class EmbedProvider(Protocol):
    def embed(self, text: str, model: str) -> list[float]: ...


class LlmProvider(Protocol):
    def chat(
        self,
        prompt: str,
        model: str,
        *,
        system: Optional[str] = None,
        messages: Optional[list[dict[str, str]]] = None,
        num_predict: Optional[int] = None,
        timeout: Optional[float] = None,
        format: Optional[str] = "json",
    ) -> str: ...


def _normalize_model_ref(model: str) -> tuple[str, str]:
    """Return (base, tag). Untagged names are treated as ``:latest`` (Ollama default)."""
    raw = (model or "").strip().lower()
    if not raw:
        return "", ""
    if ":" in raw:
        base, tag = raw.split(":", 1)
        return base.strip(), (tag.strip() or "latest")
    return raw, "latest"


def models_equivalent(requested: str, installed: str) -> bool:
    """True when ``requested`` refers to the same Ollama model as ``installed``.

    Tags must match (``qwen2.5:3b`` ≠ ``qwen2.5:7b``). Untagged names match
    ``:latest`` only, matching how Ollama resolves pulls/runs.
    """
    want_base, want_tag = _normalize_model_ref(requested)
    have_base, have_tag = _normalize_model_ref(installed)
    if not want_base or not have_base:
        return False
    return want_base == have_base and want_tag == have_tag


class OllamaProvider:
    name = "ollama"

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
        want = (model or "").strip()
        if not want:
            return False
        for name in self.list_models():
            if models_equivalent(want, name):
                return True
        return False

    def pull_model(self, model: str) -> None:
        global _last_error, _model_cache
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
            # Presence cache may still say "missing" until refresh.
            _model_cache.clear()

    def embed(self, text: str, model: str, **_kwargs: Any) -> list[float]:
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
        self,
        prompt: str,
        model: str,
        *,
        system: Optional[str] = None,
        messages: Optional[list[dict[str, str]]] = None,
        num_predict: Optional[int] = None,
        timeout: Optional[float] = None,
        format: Optional[str] = "json",
        temperature: float = 0.2,
        **_kwargs: Any,
    ) -> str:
        global _last_error
        payload_messages = self._build_messages(
            prompt, system=system, messages=messages
        )
        options: dict[str, Any] = {"temperature": float(temperature)}
        if num_predict is not None and num_predict > 0:
            options["num_predict"] = int(num_predict)
        payload: dict[str, Any] = {
            "model": model,
            "messages": payload_messages,
            "stream": False,
            "options": options,
        }
        if format:
            payload["format"] = format
        req_timeout = timeout if timeout is not None else self.timeout
        try:
            with httpx.Client(base_url=self.base_url, timeout=req_timeout) as client:
                resp = client.post("/api/chat", json=payload)
                resp.raise_for_status()
                data = resp.json()
            content = (data.get("message") or {}).get("content") or ""
            _last_error = None
            return str(content)
        except Exception as exc:  # noqa: BLE001
            _last_error = str(exc)
            raise

    def chat_stream(
        self,
        prompt: str,
        model: str,
        *,
        system: Optional[str] = None,
        messages: Optional[list[dict[str, str]]] = None,
        num_predict: Optional[int] = None,
        timeout: Optional[float] = None,
        temperature: float = 0.4,
        **_kwargs: Any,
    ) -> Iterator[str]:
        """Yield content deltas from Ollama ``/api/chat`` with streaming."""
        global _last_error
        payload_messages = self._build_messages(
            prompt, system=system, messages=messages
        )
        options: dict[str, Any] = {"temperature": float(temperature)}
        if num_predict is not None and num_predict > 0:
            options["num_predict"] = int(num_predict)
        payload: dict[str, Any] = {
            "model": model,
            "messages": payload_messages,
            "stream": True,
            "options": options,
        }
        req_timeout = timeout if timeout is not None else self.timeout
        try:
            with httpx.Client(base_url=self.base_url, timeout=req_timeout) as client:
                with client.stream("POST", "/api/chat", json=payload) as resp:
                    resp.raise_for_status()
                    for line in resp.iter_lines():
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                        except Exception:  # noqa: BLE001
                            continue
                        if data.get("error"):
                            raise RuntimeError(str(data["error"]))
                        delta = (data.get("message") or {}).get("content") or ""
                        if delta:
                            yield str(delta)
                        if data.get("done"):
                            break
            _last_error = None
        except Exception as exc:  # noqa: BLE001
            _last_error = str(exc)
            raise

    @staticmethod
    def _build_messages(
        prompt: str,
        *,
        system: Optional[str] = None,
        messages: Optional[list[dict[str, str]]] = None,
    ) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        if system:
            out.append({"role": "system", "content": system})
        if messages:
            for row in messages:
                role = str(row.get("role") or "").strip()
                content = str(row.get("content") or "")
                if role in {"user", "assistant", "system"} and content:
                    out.append({"role": role, "content": content})
        if prompt and prompt.strip():
            out.append({"role": "user", "content": prompt.strip()})
        return out


class OpenRouterProvider:
    """OpenAI-compatible chat client for OpenRouter."""

    name = "openrouter"

    def __init__(self, api_key: str, timeout: float | httpx.Timeout = 120.0):
        self.api_key = (api_key or "").strip()
        self.base_url = OPENROUTER_BASE_URL
        self.timeout = timeout
        # Cost from the most recent chat / stream / embed call (USD/credits).
        self.last_cost: Optional[float] = None

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/jm-connell/horde",
            "X-Title": "Horde",
        }

    def _client(self, timeout: float | httpx.Timeout | None = None) -> httpx.Client:
        return httpx.Client(
            base_url=self.base_url,
            timeout=timeout if timeout is not None else self.timeout,
            headers=self._headers(),
        )

    def ping(self) -> bool:
        try:
            with self._client(timeout=httpx.Timeout(5.0, connect=3.0)) as client:
                resp = client.get("/models")
                return resp.is_success
        except Exception:  # noqa: BLE001
            return False

    def list_models(self) -> list[dict[str, Any]]:
        with self._client(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
            resp = client.get("/models")
            resp.raise_for_status()
            data = resp.json()
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return []
        out: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            mid = str(row.get("id") or "").strip()
            if not mid:
                continue
            name = str(row.get("name") or mid).strip() or mid
            out.append({"id": mid, "name": name})
        out.sort(key=lambda r: str(r["id"]).lower())
        return out

    def has_model(self, model: str) -> bool:
        """Cloud models are not locally installed; treat any non-empty id as ok."""
        return bool((model or "").strip())

    @staticmethod
    def _build_messages(
        prompt: str,
        *,
        system: Optional[str] = None,
        messages: Optional[list[dict[str, str]]] = None,
    ) -> list[dict[str, str]]:
        return OllamaProvider._build_messages(
            prompt, system=system, messages=messages
        )

    def _record_usage(
        self,
        data: Any,
        *,
        model: str,
        usage_kind: Optional[str],
        video_id: Optional[int],
    ) -> Optional[float]:
        from . import cost_ledger

        self.last_cost = None
        if not isinstance(data, dict):
            return None
        if usage_kind:
            cost = cost_ledger.record_from_response(
                data,
                kind=usage_kind,
                model=model,
                video_id=video_id,
            )
        else:
            cost = cost_ledger.cost_from_usage_payload(data.get("usage"))
        self.last_cost = cost
        return cost

    def chat(
        self,
        prompt: str,
        model: str,
        *,
        system: Optional[str] = None,
        messages: Optional[list[dict[str, str]]] = None,
        num_predict: Optional[int] = None,
        timeout: Optional[float] = None,
        format: Optional[str] = "json",
        temperature: float = 0.2,
        usage_kind: Optional[str] = None,
        video_id: Optional[int] = None,
    ) -> str:
        global _last_error
        self.last_cost = None
        payload_messages = self._build_messages(
            prompt, system=system, messages=messages
        )
        payload: dict[str, Any] = {
            "model": model,
            "messages": payload_messages,
            "temperature": float(temperature),
            "stream": False,
            "usage": {"include": True},
        }
        if num_predict is not None and num_predict > 0:
            payload["max_tokens"] = int(num_predict)
        if format == "json":
            payload["response_format"] = {"type": "json_object"}
        req_timeout = timeout if timeout is not None else self.timeout
        try:
            with self._client(timeout=req_timeout) as client:
                resp = client.post("/chat/completions", json=payload)
                if resp.status_code >= 400 and format == "json":
                    # Some models reject response_format; retry without it.
                    payload.pop("response_format", None)
                    resp = client.post("/chat/completions", json=payload)
                resp.raise_for_status()
                data = resp.json()
            choices = data.get("choices") if isinstance(data, dict) else None
            if not isinstance(choices, list) or not choices:
                raise RuntimeError("OpenRouter returned no choices")
            message = choices[0].get("message") if isinstance(choices[0], dict) else {}
            content = (message or {}).get("content") or ""
            if isinstance(content, list):
                parts = [
                    str(p.get("text") or "")
                    for p in content
                    if isinstance(p, dict)
                ]
                content = "".join(parts)
            self._record_usage(
                data, model=model, usage_kind=usage_kind, video_id=video_id
            )
            _last_error = None
            return str(content)
        except Exception as exc:  # noqa: BLE001
            _last_error = str(exc)
            raise

    def chat_stream(
        self,
        prompt: str,
        model: str,
        *,
        system: Optional[str] = None,
        messages: Optional[list[dict[str, str]]] = None,
        num_predict: Optional[int] = None,
        timeout: Optional[float] = None,
        temperature: float = 0.4,
        usage_kind: Optional[str] = None,
        video_id: Optional[int] = None,
    ) -> Iterator[str]:
        global _last_error
        self.last_cost = None
        payload_messages = self._build_messages(
            prompt, system=system, messages=messages
        )
        payload: dict[str, Any] = {
            "model": model,
            "messages": payload_messages,
            "temperature": float(temperature),
            "stream": True,
            # Ask OpenRouter/OpenAI-compatible APIs for a final usage chunk.
            "stream_options": {"include_usage": True},
            "usage": {"include": True},
        }
        if num_predict is not None and num_predict > 0:
            payload["max_tokens"] = int(num_predict)
        req_timeout = timeout if timeout is not None else self.timeout
        last_usage_payload: Optional[dict[str, Any]] = None
        try:
            with self._client(timeout=req_timeout) as client:
                with client.stream("POST", "/chat/completions", json=payload) as resp:
                    resp.raise_for_status()
                    for line in resp.iter_lines():
                        if not line:
                            continue
                        if line.startswith("data:"):
                            line = line[5:].strip()
                        if not line or line == "[DONE]":
                            if line == "[DONE]":
                                break
                            continue
                        try:
                            data = json.loads(line)
                        except Exception:  # noqa: BLE001
                            continue
                        if data.get("error"):
                            err = data["error"]
                            detail = (
                                err.get("message")
                                if isinstance(err, dict)
                                else str(err)
                            )
                            raise RuntimeError(str(detail))
                        if isinstance(data, dict) and data.get("usage"):
                            last_usage_payload = data
                        choices = data.get("choices")
                        if not isinstance(choices, list) or not choices:
                            continue
                        choice = choices[0] if isinstance(choices[0], dict) else {}
                        delta = choice.get("delta") or {}
                        piece = delta.get("content") or ""
                        if piece:
                            yield str(piece)
                        # Keep reading after finish_reason so usage chunk can arrive.
            if last_usage_payload is not None:
                self._record_usage(
                    last_usage_payload,
                    model=model,
                    usage_kind=usage_kind,
                    video_id=video_id,
                )
            _last_error = None
        except Exception as exc:  # noqa: BLE001
            _last_error = str(exc)
            raise

    def embed(self, text: str, model: str, **kwargs: Any) -> list[float]:
        vecs = self.embed_many([text], model, **kwargs)
        if not vecs:
            raise RuntimeError("OpenRouter returned empty embedding")
        return vecs[0]

    def embed_many(
        self,
        texts: list[str],
        model: str,
        *,
        usage_kind: Optional[str] = "embed",
        video_id: Optional[int] = None,
    ) -> list[list[float]]:
        """Batch-embed texts via OpenRouter ``/embeddings``."""
        global _last_error
        self.last_cost = None
        cleaned = [t for t in texts if (t or "").strip()]
        if not cleaned:
            return []
        payload: dict[str, Any] = {
            "model": model,
            "input": cleaned if len(cleaned) > 1 else cleaned[0],
            "encoding_format": "float",
        }
        try:
            with self._client(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
                resp = client.post("/embeddings", json=payload)
                resp.raise_for_status()
                data = resp.json()
            rows = data.get("data") if isinstance(data, dict) else None
            if not isinstance(rows, list) or not rows:
                raise RuntimeError("OpenRouter returned no embeddings")
            ordered = sorted(
                rows,
                key=lambda r: int(r.get("index", 0)) if isinstance(r, dict) else 0,
            )
            out: list[list[float]] = []
            for row in ordered:
                if not isinstance(row, dict):
                    continue
                vec = row.get("embedding")
                if not isinstance(vec, list) or not vec:
                    raise RuntimeError("OpenRouter returned empty embedding")
                out.append([float(x) for x in vec])
            if len(out) != len(cleaned):
                raise RuntimeError(
                    f"OpenRouter embed count mismatch ({len(out)} vs {len(cleaned)})"
                )
            self._record_usage(
                data, model=model, usage_kind=usage_kind, video_id=video_id
            )
            _last_error = None
            return out
        except Exception as exc:  # noqa: BLE001
            _last_error = str(exc)
            raise

    def list_embedding_models(self) -> list[dict[str, Any]]:
        try:
            with self._client(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
                resp = client.get("/embeddings/models")
                if resp.is_success:
                    data = resp.json()
                    rows = data.get("data") if isinstance(data, dict) else None
                    if isinstance(rows, list) and rows:
                        out: list[dict[str, Any]] = []
                        for row in rows:
                            if not isinstance(row, dict):
                                continue
                            mid = str(row.get("id") or "").strip()
                            if not mid:
                                continue
                            name = str(row.get("name") or mid).strip() or mid
                            out.append({"id": mid, "name": name})
                        out.sort(key=lambda r: str(r["id"]).lower())
                        return out
        except Exception:  # noqa: BLE001
            pass
        models = self.list_models()
        return [
            m
            for m in models
            if "embed" in m["id"].lower() or "embedding" in m["id"].lower()
        ]


AnyEmbedProvider = Union[OllamaProvider, OpenRouterProvider]
AnyLlmProvider = Union[OllamaProvider, OpenRouterProvider]



def mask_openrouter_api_key(key: str) -> str:
    raw = (key or "").strip()
    if not raw:
        return ""
    if len(raw) <= 4:
        return "••••"
    return f"••••{raw[-4:]}"


def openrouter_api_key_set(stored_key: Optional[str] = None) -> bool:
    if OPENROUTER_API_KEY:
        return True
    if stored_key is not None:
        return bool(str(stored_key).strip())
    ai = app_settings.ai_settings()
    return bool(str(ai.get("openrouter_api_key") or "").strip())


def resolve_openrouter_api_key() -> str:
    if OPENROUTER_API_KEY:
        return OPENROUTER_API_KEY
    ai = app_settings.ai_settings()
    return str(ai.get("openrouter_api_key") or "").strip()


def normalize_openrouter_model(value: Any) -> str:
    raw = str(value or "").strip()
    return raw or OPENROUTER_DEFAULT_MODEL


def openrouter_configured() -> bool:
    """True when OpenRouter is enabled and an API key is available."""
    ai = app_settings.ai_settings()
    if not ai.get("openrouter_enabled"):
        return False
    return bool(resolve_openrouter_api_key())


def get_openrouter_provider(
    *, api_key: Optional[str] = None, timeout: float = 120.0
) -> Optional[OpenRouterProvider]:
    key = (api_key if api_key is not None else resolve_openrouter_api_key()).strip()
    if not key:
        return None
    return OpenRouterProvider(key, timeout=timeout)


def test_openrouter_connection(api_key: Optional[str] = None) -> dict[str, Any]:
    """Probe OpenRouter with the given key (or stored/env key)."""
    key = (api_key or "").strip()
    if not key or key.startswith("••••") or key.startswith("****"):
        key = resolve_openrouter_api_key()
    if not key:
        return {"ok": False, "detail": "No OpenRouter API key configured"}
    provider = OpenRouterProvider(key, timeout=10.0)
    try:
        models = provider.list_models()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "detail": str(exc)}
    return {
        "ok": True,
        "detail": f"Connected ({len(models)} models)",
        "model_count": len(models),
    }


def list_openrouter_models() -> list[dict[str, Any]]:
    provider = get_openrouter_provider(timeout=30.0)
    if provider is None:
        raise RuntimeError("No OpenRouter API key configured")
    return provider.list_models()


def openrouter_preset_list() -> list[dict[str, str]]:
    return [
        {"id": "budget", "label": "Budget", "model": OPENROUTER_PRESETS["budget"]},
        {"id": "best", "label": "Best", "model": OPENROUTER_PRESETS["best"]},
    ]


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


def list_openrouter_embedding_models() -> list[dict[str, Any]]:
    provider = get_openrouter_provider(timeout=30.0)
    if provider is None:
        raise RuntimeError("No OpenRouter API key configured")
    return provider.list_embedding_models()


def openrouter_scope() -> str:
    from .. import app_settings as settings_mod

    return settings_mod.normalize_openrouter_scope(
        app_settings.ai_settings().get("openrouter_scope")
    )


def openrouter_owns_embeddings() -> bool:
    """True when OpenRouter should handle embeddings (scope=all, no Ollama override)."""
    if not openrouter_configured():
        return False
    if openrouter_scope() != "all":
        return False
    ai = app_settings.ai_settings()
    if ai.get("ollama_prefer_embeddings") and get_ollama_provider() is not None:
        return False
    return True


def get_ollama_provider() -> Optional[OllamaProvider]:
    """Ollama instance when local AI is enabled and reachable."""
    ai = app_settings.ai_settings()
    if not ai.get("enabled", True):
        return None
    if (ai.get("provider") or "ollama") != "ollama":
        return None
    url = resolve_base_url()
    if not url:
        return None
    return OllamaProvider(url)


def get_embed_provider() -> Optional[AnyEmbedProvider]:
    """Provider for embeddings: OpenRouter (scope=all) or Ollama."""
    if openrouter_owns_embeddings():
        return get_openrouter_provider()
    return get_ollama_provider()


def get_provider() -> Optional[OllamaProvider]:
    """Ollama-only helper (pull/workload). Use ``get_embed_provider`` for vectors."""
    return get_ollama_provider()


def get_llm_provider() -> Optional[AnyLlmProvider]:
    """OpenRouter when connected; otherwise Ollama chat when local AI is up."""
    if openrouter_configured():
        provider = get_openrouter_provider()
        if provider is not None:
            return provider
    return get_ollama_provider()


def resolve_llm_model(provider: Optional[AnyLlmProvider] = None) -> str:
    """Chat model id for the active LLM backend."""
    ai = app_settings.ai_settings()
    active = provider if provider is not None else get_llm_provider()
    if isinstance(active, OpenRouterProvider):
        return normalize_openrouter_model(ai.get("openrouter_model"))
    return str(ai.get("chat_model") or "llama3.2:3b")


def resolve_embed_model(provider: Optional[AnyEmbedProvider] = None) -> str:
    """Embedding model id for the active embed backend."""
    from .. import app_settings as settings_mod

    ai = app_settings.ai_settings()
    active = provider if provider is not None else get_embed_provider()
    if isinstance(active, OpenRouterProvider):
        return settings_mod.normalize_openrouter_embed_model(
            ai.get("openrouter_embed_model")
        )
    return str(ai.get("embed_model") or "nomic-embed-text")


def llm_backend_name() -> Optional[str]:
    if openrouter_configured():
        return "openrouter"
    if app_settings.ai_settings().get("enabled", True):
        return "ollama"
    return None


def embed_backend_name() -> Optional[str]:
    if openrouter_owns_embeddings():
        return "openrouter"
    if app_settings.ai_settings().get("enabled", True):
        return "ollama"
    return None


def require_llm_chat_model(
    provider: AnyLlmProvider, chat_model: str
) -> Optional[str]:
    """Return an error if the chat model is unavailable (Ollama only)."""
    if isinstance(provider, OpenRouterProvider):
        if not (chat_model or "").strip():
            return "OpenRouter model is not set"
        return None
    return require_chat_model(provider, chat_model)


def llm_features_allowed() -> tuple[bool, Optional[str]]:
    """Whether summarize/chat/etc. may run (ignores live reachability)."""
    ai = app_settings.ai_settings()
    if ai.get("paused"):
        return False, "AI is paused"
    if openrouter_configured():
        return True, None
    if not ai.get("enabled", True):
        return False, "AI is disabled"
    return True, None


def ensure_models(provider: OllamaProvider) -> tuple[bool, bool]:
    """Ensure embed/chat models exist; kick off pulls if configured.

    Returns (embed_present, chat_present). Model tags must match exactly
    (``qwen2.5:3b`` is not satisfied by ``qwen2.5:7b``).
    """
    global _model_cache
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

            # Drop stale "present" cache so status shows the pull promptly.
            _model_cache.clear()
            threading.Thread(target=_pull, daemon=True).start()
    return embed_ok, chat_ok


def require_chat_model(provider: OllamaProvider, chat_model: str) -> Optional[str]:
    """Return an error message if chat model is missing; start auto-pull when enabled."""
    if provider.has_model(chat_model):
        return None
    ai = app_settings.ai_settings()
    if ai.get("auto_pull_models", True):
        ensure_models(provider)
        return (
            f"Chat model '{chat_model}' is not installed on Ollama; "
            "download started. Try again in a minute."
        )
    return (
        f"Chat model '{chat_model}' is not installed on Ollama. "
        "Enable auto-pull or install it manually."
    )


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


def _openrouter_status_fields(ai: dict[str, Any], *, quick: bool = False) -> dict[str, Any]:
    from .. import app_settings as settings_mod

    enabled = bool(ai.get("openrouter_enabled"))
    key_set = openrouter_api_key_set(str(ai.get("openrouter_api_key") or ""))
    model = normalize_openrouter_model(ai.get("openrouter_model"))
    scope = settings_mod.normalize_openrouter_scope(ai.get("openrouter_scope"))
    embed_model = settings_mod.normalize_openrouter_embed_model(
        ai.get("openrouter_embed_model")
    )
    prefer = bool(ai.get("ollama_prefer_embeddings"))
    reachable = False
    if enabled and key_set and not quick:
        provider = get_openrouter_provider()
        if provider is not None:
            reachable = provider.ping()
    elif enabled and key_set and quick:
        reachable = True
    return {
        "openrouter_enabled": enabled,
        "openrouter_reachable": reachable,
        "openrouter_model": model,
        "openrouter_api_key_set": key_set,
        "openrouter_scope": scope,
        "openrouter_embed_model": embed_model,
        "ollama_prefer_embeddings": prefer,
        "llm_backend": llm_backend_name(),
        "embed_backend": embed_backend_name(),
    }


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
    or_fields = _openrouter_status_fields(ai, quick=quick)

    # Effective embed model for status (may be OpenRouter).
    effective_embed = resolve_embed_model() if (enabled or openrouter_owns_embeddings()) else embed_model

    if not enabled and not openrouter_owns_embeddings():
        return ProviderStatus(
            enabled=False,
            provider=provider_name,
            ready=False,
            reachable=False,
            base_url=_settings_url() or None,
            embed_model=effective_embed,
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
            **or_fields,
        )

    if openrouter_owns_embeddings():
        # Cloud embeds: ready when OpenRouter is configured (skip Ollama model pull).
        return ProviderStatus(
            enabled=enabled or bool(ai.get("openrouter_enabled")),
            provider="openrouter" if openrouter_owns_embeddings() else provider_name,
            ready=bool(or_fields.get("openrouter_reachable") or or_fields.get("openrouter_api_key_set")),
            reachable=bool(or_fields.get("openrouter_reachable") or or_fields.get("openrouter_api_key_set")),
            base_url=_settings_url() or None,
            embed_model=effective_embed,
            chat_model=resolve_llm_model() if openrouter_configured() else chat_model,
            embed_model_present=True,
            chat_model_present=True,
            pulling=[],
            last_error=_last_error,
            paused=bool(ai.get("paused")),
            schedule=str(ai.get("schedule") or "on_download"),
            indexed_videos=indexed_videos,
            total_videos=total_videos,
            queue_depth=queue_depth,
            **or_fields,
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
        **or_fields,
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
