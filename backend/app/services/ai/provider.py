"""LLM / embedding provider: any OpenAI-compatible endpoint.

Chat and embeddings each use one connection (base URL + optional API key);
embeddings share the chat connection unless Settings name a second one. Two
providers get extras on top of the common API: OpenRouter (model prices,
per-call cost, budget presets) and Ollama (model download, GPU sizing), the
latter only when the endpoint's host also answers Ollama's ``/api/version``.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlparse

import httpx

from ...config import OLLAMA_BASE_URL, OPENROUTER_API_KEY
from .. import app_settings
from ..app_settings import normalize_base_url

logger = logging.getLogger(__name__)

OPENROUTER_PRESETS: dict[str, str] = {
    "budget": "google/gemini-2.5-flash-lite",
    "best": "google/gemini-2.5-flash",
}
OPENROUTER_DEFAULT_MODEL = OPENROUTER_PRESETS["budget"]

ProviderKind = Literal["openrouter", "ollama", "openai_compatible"]
Target = Literal["chat", "embed"]


def classify_provider_error(exc: BaseException) -> tuple[str, str]:
    """Map provider exceptions to (kind, user-facing message) for job/status UI."""
    if isinstance(exc, httpx.TimeoutException):
        return "timeout", "AI provider request timed out"
    if isinstance(exc, (httpx.ConnectError, httpx.NetworkError)):
        return "network", "Could not reach AI provider"
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code if exc.response is not None else 0
        if code in (401, 403):
            return "auth", "AI provider rejected credentials"
        if code == 429:
            return "rate_limit", "AI provider rate limited the request"
        return "http", f"AI provider HTTP {code}"
    msg = str(exc).strip() or "AI provider request failed"
    return "unknown", msg


def format_provider_error(exc: BaseException) -> str:
    kind, message = classify_provider_error(exc)
    if kind == "unknown":
        return message
    return f"{message} ({kind})"


def _retry_after_sec(resp: httpx.Response) -> float | None:
    """The response's ``Retry-After`` in seconds, when it is a number."""
    try:
        return max(0.0, float(resp.headers.get("retry-after", "")))
    except ValueError:
        return None


def _error_detail(resp: httpx.Response) -> str:
    """The provider's own error message (OpenRouter names the upstream cause)."""
    try:
        err = resp.json().get("error")
    except ValueError, AttributeError:
        return resp.text[:300] or f"HTTP {resp.status_code}"
    if isinstance(err, dict):
        meta = err.get("metadata") or {}
        raw = meta.get("raw") if isinstance(meta, dict) else None
        msg = str(err.get("message") or "")
        return f"{msg}: {raw}"[:300] if raw else msg[:300]
    return str(err)[:300]


ChatFormat = str | dict[str, Any] | None


def _json_value_has_text(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return any(_json_value_has_text(v) for v in value)
    if isinstance(value, dict):
        return any(_json_value_has_text(v) for v in value.values())
    return False


def is_empty_json_payload(raw: str) -> bool:
    """True when ``raw`` is empty or JSON with no string payload (e.g. ``{  }``)."""
    text = (raw or "").strip()
    if not text:
        return True
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return False
    if data in ({}, [], None):
        return True
    if isinstance(data, dict):
        return not any(_json_value_has_text(v) for v in data.values())
    if isinstance(data, list):
        return not any(_json_value_has_text(v) for v in data)
    if isinstance(data, str):
        return not data.strip()
    return False


def _stringify_message_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
        return "".join(parts)
    return str(content)


def assistant_message_text(message: Any) -> str:
    """Best-effort assistant text from an OpenAI/Ollama chat message.

    JSON mode plus thinking models (Gemini 2.5, Qwen3, …) often leave
    ``content`` as ``{  }`` and put the real answer in ``reasoning`` /
    ``thinking``.
    """
    if not isinstance(message, dict):
        return ""
    content = _stringify_message_content(message.get("content"))
    extras: list[str] = []
    for key in ("reasoning", "reasoning_content", "thinking"):
        extra = message.get(key)
        if isinstance(extra, str) and extra.strip():
            extras.append(extra.strip())
    details = message.get("reasoning_details")
    if isinstance(details, list):
        for item in details:
            if isinstance(item, dict):
                text = item.get("text") or item.get("content") or ""
                if isinstance(text, str) and text.strip():
                    extras.append(text.strip())
            elif isinstance(item, str) and item.strip():
                extras.append(item.strip())
    if content.strip() and not is_empty_json_payload(content):
        return content
    if extras:
        return "\n".join(extras)
    return content


def openrouter_response_format(fmt: ChatFormat) -> dict[str, Any] | None:
    """Map Horde's chat ``format`` into OpenRouter ``response_format``."""
    if not fmt:
        return None
    if isinstance(fmt, dict):
        return {
            "type": "json_schema",
            "json_schema": {
                "name": "result",
                "strict": True,
                "schema": fmt,
            },
        }
    if fmt == "json":
        return {"type": "json_object"}
    return None


# Keep probes snappy: reachability is checked from request handlers too.
_PING_TIMEOUT = httpx.Timeout(3.0, connect=2.0)
_DETECT_TIMEOUT = httpx.Timeout(0.6, connect=0.4)
_NEGATIVE_CACHE_SEC = 30.0
_OLLAMA_PROBE_SEC = 300.0
#: Waits before re-sending a chat stream the provider answered with 429.
#: Hosted models get rate limited upstream for a second or two at a time.
_RATE_LIMIT_BACKOFF_SEC = (1.0, 2.0, 4.0)
#: A ``Retry-After`` longer than this is not waited out: the user sees the error.
_RATE_LIMIT_MAX_WAIT_SEC = 10.0
_MODEL_CACHE_SEC = 30.0

_pull_lock = threading.Lock()
_pulling: set[str] = set()
_last_error: str | None = None
# base_url -> (reachable, checked_at). A success is trusted until a call fails
# (invalidate_resolved_url); a failure is retried after _NEGATIVE_CACHE_SEC.
_reach_cache: dict[str, tuple[bool, float]] = {}
# Ollama root URL -> (is_ollama, checked_at).
_ollama_cache: dict[str, tuple[bool, float]] = {}
_model_cache: dict[str, tuple[float, bool]] = {}


@dataclass
class ProviderStatus:
    enabled: bool
    configured: bool
    provider: str
    ready: bool
    reachable: bool
    base_url: str | None
    embed_model: str
    chat_model: str
    embed_model_present: bool
    chat_model_present: bool
    embed_provider: str = ""
    embed_base_url: str | None = None
    embed_reachable: bool = False
    reports_cost: bool = False
    pulling: list[str] = field(default_factory=list)
    last_error: str | None = None
    paused: bool = False
    schedule: str = "on_download"
    indexed_videos: int = 0
    total_videos: int = 0
    queue_depth: int = 0


@dataclass(frozen=True)
class Connection:
    """One OpenAI-compatible endpoint: ``base_url`` ends at ``/v1`` (or similar)."""

    base_url: str
    api_key: str = ""

    @property
    def is_openrouter(self) -> bool:
        return _host(self.base_url) == "openrouter.ai"


def _host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def ollama_root(base_url: str) -> str:
    """Ollama's native API lives beside ``/v1``: strip it to reach ``/api/*``."""
    url = base_url.rstrip("/")
    return url[:-3] if url.endswith("/v1") else url


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


class OllamaAdmin:
    """Ollama's native model management (list, download); chat goes over ``/v1``."""

    def __init__(self, root_url: str, timeout: float | httpx.Timeout = 10.0):
        self.base_url = root_url.rstrip("/")
        self.timeout = timeout

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=self.base_url, timeout=self.timeout)

    def ping(self) -> bool:
        try:
            with self._client() as client:
                return client.get("/api/version").is_success
        except Exception:
            logger.debug("Ollama version probe failed", exc_info=True)
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
        return any(models_equivalent(want, name) for name in self.list_models())

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
        except Exception as exc:
            _last_error = f"Failed to pull {model}: {format_provider_error(exc)}"
            logger.warning(_last_error)
            raise
        finally:
            with _pull_lock:
                _pulling.discard(model)
            # Presence cache may still say "missing" until refresh.
            _model_cache.clear()


def _build_messages(
    prompt: str,
    *,
    system: str | None = None,
    messages: list[dict[str, str]] | None = None,
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


class OpenAICompatProvider:
    """Chat and embeddings over the OpenAI API shape (``/chat/completions``, ...)."""

    def __init__(self, connection: Connection, timeout: float | httpx.Timeout = 120.0):
        self.connection = connection
        self.base_url = connection.base_url
        self.api_key = connection.api_key
        self.timeout = timeout
        # Cost from the most recent chat / stream / embed call, when the
        # provider reports one (OpenRouter's usage.cost).
        self.last_cost: float | None = None

    @property
    def name(self) -> str:
        return "openrouter" if self.connection.is_openrouter else "openai_compatible"

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.connection.is_openrouter:
            headers["HTTP-Referer"] = "https://github.com/jm-connell/horde"
            headers["X-Title"] = "Horde"
        return headers

    def _client(self, timeout: float | httpx.Timeout | None = None) -> httpx.Client:
        return httpx.Client(
            base_url=self.base_url,
            timeout=timeout if timeout is not None else self.timeout,
            headers=self._headers(),
        )

    def ping(
        self, timeout: httpx.Timeout = _PING_TIMEOUT, *, strict: bool = False
    ) -> bool:
        """True when the server answers ``GET /models``.

        Any answer below 500 counts (a 401 means a wrong key, which the real
        call reports; some servers have no ``/models``). ``strict`` wants a
        success, for telling an AI server from any web server on a port.
        """
        try:
            with self._client(timeout=timeout) as client:
                resp = client.get("/models")
                return resp.is_success if strict else resp.status_code < 500
        except Exception:
            logger.debug("AI provider health probe failed", exc_info=True)
            return False

    def _model_rows(self, path: str) -> list[Any]:
        with self._client(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
            resp = client.get(path)
            resp.raise_for_status()
            data = resp.json()
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            # Some servers return a bare list or Ollama-style {"models": [...]}.
            rows = data if isinstance(data, list) else data.get("models")
        return rows if isinstance(rows, list) else []

    def list_models(self) -> list[dict[str, Any]]:
        """Text chat models the endpoint offers (OpenRouter rows carry prices)."""
        out: list[dict[str, Any]] = []
        for row in self._model_rows("/models"):
            if not is_openrouter_text_llm(row):
                continue
            parsed = parse_openrouter_catalog_row(row)
            if parsed:
                out.append(parsed)
        out.sort(key=lambda r: str(r["id"]).lower())
        return out

    def list_embedding_models(self) -> list[dict[str, Any]]:
        """Embedding models: OpenRouter's catalog, else ids that look like one."""
        if self.connection.is_openrouter:
            try:
                rows = [
                    parsed
                    for parsed in map(
                        parse_openrouter_catalog_row,
                        self._model_rows("/embeddings/models"),
                    )
                    if parsed
                ]
                if rows:
                    return sorted(rows, key=lambda r: str(r["id"]).lower())
            except Exception:
                logger.debug(
                    "OpenRouter embedding catalog unavailable; "
                    "falling back to the model list",
                    exc_info=True,
                )
        rows = [
            parsed
            for parsed in map(parse_openrouter_catalog_row, self._model_rows("/models"))
            if parsed
        ]
        return sorted(
            (m for m in rows if "embed" in m["id"].lower()),
            key=lambda r: str(r["id"]).lower(),
        )

    def has_model(self, model: str) -> bool:
        """Ollama: the model is installed. Elsewhere any non-empty id may work."""
        if not (model or "").strip():
            return False
        return _model_present(self.connection, model, pull=False)

    def _record_usage(
        self,
        data: Any,
        *,
        model: str,
        usage_kind: str | None,
        video_id: int | None,
    ) -> float | None:
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

    def _assert_budget(self) -> None:
        # Only OpenRouter reports cost, so only its calls count against the budget.
        if self.connection.is_openrouter:
            from . import cost_ledger

            cost_ledger.assert_budget_allows()

    def _usage_fields(self) -> dict[str, Any]:
        # OpenRouter-only request field; strict servers (OpenAI) reject unknown ones.
        return {"usage": {"include": True}} if self.connection.is_openrouter else {}

    def chat(
        self,
        prompt: str,
        model: str,
        *,
        system: str | None = None,
        messages: list[dict[str, str]] | None = None,
        num_predict: int | None = None,
        timeout: float | None = None,
        format: ChatFormat = "json",
        temperature: float = 0.2,
        usage_kind: str | None = None,
        video_id: int | None = None,
    ) -> str:
        global _last_error
        self.last_cost = None

        self._assert_budget()
        payload: dict[str, Any] = {
            "model": model,
            "messages": _build_messages(prompt, system=system, messages=messages),
            "temperature": float(temperature),
            "stream": False,
            **self._usage_fields(),
        }
        if num_predict is not None and num_predict > 0:
            payload["max_tokens"] = int(num_predict)
        rf = openrouter_response_format(format)
        if rf:
            payload["response_format"] = rf
        req_timeout = timeout if timeout is not None else self.timeout
        try:
            with self._client(timeout=req_timeout) as client:
                resp = client.post("/chat/completions", json=payload)
                if resp.status_code in (400, 422) and "response_format" in payload:
                    # Schema/json_object unsupported: loosen, then drop format.
                    payload.pop("response_format", None)
                    if isinstance(format, dict):
                        payload["response_format"] = {"type": "json_object"}
                        resp = client.post("/chat/completions", json=payload)
                        if resp.status_code in (400, 422):
                            payload.pop("response_format", None)
                            resp = client.post("/chat/completions", json=payload)
                    else:
                        resp = client.post("/chat/completions", json=payload)
                resp.raise_for_status()
                data = resp.json()
            choices = data.get("choices") if isinstance(data, dict) else None
            if not isinstance(choices, list) or not choices:
                raise RuntimeError("AI provider returned no choices")
            message = choices[0].get("message") if isinstance(choices[0], dict) else {}
            content = assistant_message_text(message or {})
            self._record_usage(
                data, model=model, usage_kind=usage_kind, video_id=video_id
            )
            _last_error = None
            return content
        except Exception as exc:
            _last_error = format_provider_error(exc)
            invalidate_resolved_url()
            raise

    def _send_retrying_429(
        self, client: httpx.Client, payload: dict[str, Any]
    ) -> httpx.Response:
        """POST a streaming chat request, waiting out short 429s.

        Nothing has been streamed when a 429 arrives, so sending again is safe.
        Returns the last response, which the caller must close.
        """
        for wait in (*_RATE_LIMIT_BACKOFF_SEC, None):
            request = client.build_request("POST", "/chat/completions", json=payload)
            resp = client.send(request, stream=True)
            if resp.status_code != 429:
                return resp
            resp.read()
            retry_after = _retry_after_sec(resp)
            if retry_after is not None and wait is not None:
                wait = retry_after if retry_after <= _RATE_LIMIT_MAX_WAIT_SEC else None
            logger.warning(
                "AI provider rate limited a chat (%s); %s",
                _error_detail(resp),
                f"retrying in {wait:g}s" if wait is not None else "giving up",
            )
            if wait is None:
                return resp
            resp.close()
            time.sleep(wait)
        raise AssertionError("unreachable")

    def chat_stream(
        self,
        prompt: str,
        model: str,
        *,
        system: str | None = None,
        messages: list[dict[str, str]] | None = None,
        num_predict: int | None = None,
        timeout: float | None = None,
        temperature: float = 0.4,
        usage_kind: str | None = None,
        video_id: int | None = None,
    ) -> Iterator[str]:
        global _last_error
        self.last_cost = None

        self._assert_budget()
        payload: dict[str, Any] = {
            "model": model,
            "messages": _build_messages(prompt, system=system, messages=messages),
            "temperature": float(temperature),
            "stream": True,
            # Ask for a final usage chunk (part of the OpenAI API).
            "stream_options": {"include_usage": True},
            **self._usage_fields(),
        }
        if num_predict is not None and num_predict > 0:
            payload["max_tokens"] = int(num_predict)
        req_timeout = timeout if timeout is not None else self.timeout
        last_usage_payload: dict[str, Any] | None = None
        try:
            with (
                self._client(timeout=req_timeout) as client,
                closing(self._send_retrying_429(client, payload)) as resp,
            ):
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
                    except Exception:
                        logger.debug(
                            "skipping a malformed AI stream line", exc_info=True
                        )
                        continue
                    if data.get("error"):
                        err = data["error"]
                        detail = (
                            err.get("message") if isinstance(err, dict) else str(err)
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
        except Exception as exc:
            _last_error = format_provider_error(exc)
            invalidate_resolved_url()
            raise

    def embed(self, text: str, model: str, **kwargs: Any) -> list[float]:
        vecs = self.embed_many([text], model, **kwargs)
        if not vecs:
            raise RuntimeError("AI provider returned an empty embedding")
        return vecs[0]

    def embed_many(
        self,
        texts: list[str],
        model: str,
        *,
        usage_kind: str | None = "embed",
        video_id: int | None = None,
    ) -> list[list[float]]:
        """Batch-embed texts via ``/embeddings``."""
        global _last_error
        self.last_cost = None

        self._assert_budget()
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
                raise RuntimeError("AI provider returned no embeddings")
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
                    raise RuntimeError("AI provider returned an empty embedding")
                out.append([float(x) for x in vec])
            if len(out) != len(cleaned):
                raise RuntimeError(
                    f"AI provider embed count mismatch ({len(out)} vs {len(cleaned)})"
                )
            self._record_usage(
                data, model=model, usage_kind=usage_kind, video_id=video_id
            )
            _last_error = None
            return out
        except Exception as exc:
            _last_error = format_provider_error(exc)
            invalidate_resolved_url()
            raise


def usd_per_million(raw: Any) -> float | None:
    """Convert OpenRouter USD-per-token list prices to USD per 1M tokens."""
    if raw is None or raw == "":
        return None
    try:
        per_token = float(raw)
    except TypeError, ValueError:
        return None
    if per_token < 0 or per_token != per_token:
        return None
    return round(per_token * 1_000_000.0, 6)


_NON_TEXT_OUTPUT = frozenset({"image", "audio", "video", "embeddings", "embedding"})


def is_openrouter_text_llm(row: Any) -> bool:
    """True when the model can do Horde's text chat workload.

    Vision models that also accept images are kept (we only send text).
    Image/audio generators, TTS/music, and embedding models are excluded.
    Rows without architecture metadata (most non-OpenRouter servers) are kept.
    """
    if not isinstance(row, dict):
        return False
    arch = row.get("architecture")
    if not isinstance(arch, dict):
        return True
    outputs = arch.get("output_modalities")
    if isinstance(outputs, list) and outputs:
        out_set = {
            str(x).strip().lower() for x in outputs if x is not None and str(x).strip()
        }
        if "text" not in out_set or out_set & _NON_TEXT_OUTPUT:
            return False
        inputs = arch.get("input_modalities")
        if isinstance(inputs, list) and inputs:
            in_set = {
                str(x).strip().lower()
                for x in inputs
                if x is not None and str(x).strip()
            }
            if in_set and "text" not in in_set:
                return False
        return True
    modality = str(arch.get("modality") or "").strip().lower()
    if not modality or "->" not in modality:
        return True
    left, right = modality.split("->", 1)
    in_parts = {p.strip() for p in left.split("+") if p.strip()}
    out_parts = {p.strip() for p in right.split("+") if p.strip()}
    if "text" not in in_parts or "text" not in out_parts:
        return False
    return not out_parts & _NON_TEXT_OUTPUT


def parse_openrouter_catalog_row(row: Any) -> dict[str, Any] | None:
    """Normalize a ``/models`` row to id, name, and $/M prices (OpenRouter only)."""
    if not isinstance(row, dict):
        return None
    mid = str(row.get("id") or row.get("name") or row.get("model") or "").strip()
    if not mid:
        return None
    name = str(row.get("name") or mid).strip() or mid
    pricing = row.get("pricing")
    prompt = None
    completion = None
    if isinstance(pricing, dict):
        prompt = usd_per_million(pricing.get("prompt"))
        completion = usd_per_million(pricing.get("completion"))
    return {
        "id": mid,
        "name": name,
        "prompt_per_million": prompt,
        "completion_per_million": completion,
    }


def mask_api_key(key: str) -> str:
    raw = (key or "").strip()
    if not raw:
        return ""
    if len(raw) <= 4:
        return "••••"
    return f"••••{raw[-4:]}"


def is_masked_key(key: str | None) -> bool:
    return (key or "").startswith(("••••", "****"))


def env_key_for(base_url: str) -> str:
    # OPENROUTER_API_KEY overrides the saved key, and only ever goes to OpenRouter.
    return OPENROUTER_API_KEY if _host(base_url) == "openrouter.ai" else ""


def chat_connection() -> Connection | None:
    """The chat endpoint from Settings (OLLAMA_BASE_URL as a legacy fallback)."""
    ai = app_settings.ai_settings()
    if not ai.get("enabled", True):
        return None
    url = str(ai.get("base_url") or "") or normalize_base_url(OLLAMA_BASE_URL)
    if not url:
        return None
    key = env_key_for(url) or str(ai.get("api_key") or "")
    return Connection(url, key)


def _embed_endpoint() -> Connection | None:
    """Where embeddings go, whether or not an embedding model is set."""
    ai = app_settings.ai_settings()
    if not ai.get("enabled", True):
        return None
    if ai.get("autodetect_ollama") == "embed":
        # A migrated install's embeddings Ollama is not found yet; falling back
        # to the chat endpoint would send Ollama model ids (and its key) there.
        return None
    url = str(ai.get("embed_base_url") or "")
    if not url:
        return chat_connection()
    key = env_key_for(url) or str(ai.get("embed_api_key") or "")
    return Connection(url, key)


def embed_connection() -> Connection | None:
    """The embeddings endpoint (its own when set, else the chat one) with a model."""
    if not str(app_settings.ai_settings().get("embed_model") or ""):
        return None
    return _embed_endpoint()


def connection_for(target: Target) -> Connection | None:
    return chat_connection() if target == "chat" else embed_connection()


def ollama_admin(conn: Connection | None) -> OllamaAdmin | None:
    """Ollama's native API behind ``conn``, when its host is an Ollama server."""
    if conn is None or conn.is_openrouter:
        return None
    root = ollama_root(conn.base_url)
    now = time.monotonic()
    cached = _ollama_cache.get(root)
    if cached is None or (now - cached[1]) > _OLLAMA_PROBE_SEC:
        is_ollama = OllamaAdmin(root, timeout=_PING_TIMEOUT).ping()
        cached = (is_ollama, now)
        _ollama_cache[root] = cached
    return OllamaAdmin(root) if cached[0] else None


def connection_kind(conn: Connection | None) -> ProviderKind | Literal[""]:
    if conn is None:
        return ""
    if conn.is_openrouter:
        return "openrouter"
    return "ollama" if ollama_admin(conn) is not None else "openai_compatible"


def ollama_root_url() -> str | None:
    """Root URL of the Ollama server Horde uses, if any (for GPU sizing)."""
    for conn in (chat_connection(), embed_connection()):
        admin = ollama_admin(conn)
        if admin is not None:
            return admin.base_url
    return None


def _reachable(conn: Connection) -> bool:
    now = time.monotonic()
    cached = _reach_cache.get(conn.base_url)
    if cached is not None:
        ok, at = cached
        if ok or (now - at) < _NEGATIVE_CACHE_SEC:
            return ok
    global _last_error
    ok = OpenAICompatProvider(conn).ping()
    _reach_cache[conn.base_url] = (ok, now)
    if not ok:
        _last_error = "AI provider not reachable"
    return ok


def get_llm_provider() -> OpenAICompatProvider | None:
    """Chat provider when configured and reachable."""
    conn = chat_connection()
    if conn is None or not _reachable(conn):
        return None
    return OpenAICompatProvider(conn)


def get_embed_provider() -> OpenAICompatProvider | None:
    """Embedding provider when configured (with a model) and reachable."""
    conn = embed_connection()
    if conn is None or not _reachable(conn):
        return None
    return OpenAICompatProvider(conn)


def resolve_llm_model(_provider: OpenAICompatProvider | None = None) -> str:
    return str(app_settings.ai_settings().get("chat_model") or "")


def resolve_embed_model(_provider: OpenAICompatProvider | None = None) -> str:
    return str(app_settings.ai_settings().get("embed_model") or "")


def llm_configured() -> bool:
    """A chat endpoint and model are set (it may still be unreachable)."""
    return chat_connection() is not None and bool(resolve_llm_model())


def embeddings_configured() -> bool:
    return embed_connection() is not None


def llm_backend_name() -> str | None:
    return connection_kind(chat_connection()) or None


def embed_backend_name() -> str | None:
    return connection_kind(embed_connection()) or None


def require_llm_chat_model(
    provider: OpenAICompatProvider, chat_model: str
) -> str | None:
    """Return an error when the chat model cannot run (unset, or not on Ollama)."""
    if not (chat_model or "").strip():
        return "No chat model is set (Settings → AI)"
    admin = ollama_admin(provider.connection)
    if admin is None or admin.has_model(chat_model):
        return None
    if app_settings.ai_settings().get("auto_pull_models", True):
        ensure_models()
        # The model asked for may be the assistant's own, not the chat model.
        _model_present(provider.connection, chat_model, pull=True)
        return (
            f"Chat model '{chat_model}' is not installed on Ollama; "
            "download started. Try again in a minute."
        )
    return (
        f"Chat model '{chat_model}' is not installed on Ollama. "
        "Enable auto-download or install it manually."
    )


def llm_features_allowed() -> tuple[bool, str | None]:
    """Whether summarize/chat/etc. may run (ignores live reachability)."""
    ai = app_settings.ai_settings()
    if ai.get("paused"):
        return False, "AI is paused"
    if not ai.get("enabled", True):
        return False, "AI is disabled"
    if not llm_configured():
        return False, "No AI provider is set up"
    return True, None


def _start_pull(admin: OllamaAdmin, model: str) -> None:
    def _pull() -> None:
        from .. import activity

        handle = activity.start(
            "model_pull",
            "Downloading an AI model",
            reason="Required Ollama model is missing",
            engine="ollama",
            detail=model,
        )
        try:
            admin.pull_model(model)
            handle.finish(detail=model)
        except Exception as exc:
            logger.warning("model pull failed", exc_info=True)
            handle.finish(status="failed", error=str(exc)[:500])

    _model_cache.clear()
    threading.Thread(target=_pull, daemon=True).start()


def _model_present(conn: Connection | None, model: str, *, pull: bool) -> bool:
    """True when ``model`` can run on ``conn``; only Ollama is actually checked."""
    if conn is None or not model:
        return False
    admin = ollama_admin(conn)
    if admin is None:
        return True
    key = f"{admin.base_url}|{model}"
    now = time.monotonic()
    cached = _model_cache.get(key)
    if cached and (now - cached[0]) < _MODEL_CACHE_SEC:
        return cached[1]
    try:
        present = admin.has_model(model)
    except Exception as exc:
        logger.debug("model availability check failed", exc_info=True)
        global _last_error
        _last_error = format_provider_error(exc)
        return False
    if not present and pull:
        with _pull_lock:
            already = model in _pulling
        if not already:
            _start_pull(admin, model)
    _model_cache[key] = (now, present)
    return present


def ensure_models() -> tuple[bool, bool]:
    """Check the configured models; download missing Ollama ones when allowed.

    Returns (embed_present, chat_present). Model tags must match exactly
    (``qwen2.5:3b`` is not satisfied by ``qwen2.5:7b``).
    """
    _model_cache.clear()
    pull = bool(app_settings.ai_settings().get("auto_pull_models", True))
    embed_ok = _model_present(embed_connection(), resolve_embed_model(), pull=pull)
    chat_ok = _model_present(chat_connection(), resolve_llm_model(), pull=pull)
    return embed_ok, chat_ok


def pulling_models() -> list[str]:
    with _pull_lock:
        return sorted(_pulling)


def last_error() -> str | None:
    return _last_error


def invalidate_resolved_url() -> None:
    """Forget reachability and model caches (after a failure or a settings change)."""
    _reach_cache.clear()
    _ollama_cache.clear()
    _model_cache.clear()


def build_status(
    *,
    indexed_videos: int = 0,
    total_videos: int = 0,
    queue_depth: int = 0,
) -> ProviderStatus:
    ai = app_settings.ai_settings()
    chat = chat_connection()
    embed = embed_connection()
    chat_model = resolve_llm_model()
    embed_model = resolve_embed_model()
    pull = bool(ai.get("auto_pull_models", True))
    chat_reach = chat is not None and _reachable(chat)
    embed_reach = embed is not None and _reachable(embed)
    chat_ok = chat_reach and _model_present(chat, chat_model, pull=pull)
    embed_ok = embed_reach and _model_present(embed, embed_model, pull=pull)
    separate_embed = bool(ai.get("embed_base_url"))
    return ProviderStatus(
        enabled=bool(ai.get("enabled", True)),
        configured=chat is not None,
        provider=connection_kind(chat),
        # Ready = semantic search works; chat readiness is chat_model_present.
        ready=embed_ok,
        reachable=chat_reach,
        base_url=chat.base_url if chat else None,
        embed_model=embed_model,
        chat_model=chat_model,
        embed_model_present=embed_ok,
        chat_model_present=chat_ok,
        embed_provider=connection_kind(embed),
        embed_base_url=embed.base_url if (embed and separate_embed) else None,
        embed_reachable=embed_reach,
        reports_cost=any(c is not None and c.is_openrouter for c in (chat, embed)),
        pulling=pulling_models(),
        last_error=_last_error,
        paused=bool(ai.get("paused")),
        schedule=str(ai.get("schedule") or "on_download"),
        indexed_videos=indexed_videos,
        total_videos=total_videos,
        queue_depth=queue_depth,
    )


def health_summary() -> dict[str, Any]:
    """Chat connection state from the caches only: ``/api/health`` must stay cheap."""
    ai = app_settings.ai_settings()
    chat = chat_connection()
    reachable = False
    kind: str | None = None
    if chat is not None:
        cached = _reach_cache.get(chat.base_url)
        reachable = bool(cached and cached[0])
        probed = _ollama_cache.get(ollama_root(chat.base_url))
        if chat.is_openrouter:
            kind = "openrouter"
        elif probed is not None:
            kind = "ollama" if probed[0] else "openai_compatible"
    return {
        "enabled": bool(ai.get("enabled", True)),
        "configured": chat is not None,
        "provider": kind,
        "reachable": reachable,
        "base_url": chat.base_url if chat else None,
        "pulling": pulling_models(),
        "last_error": _last_error,
    }


def _connection_error_detail(exc: Exception) -> str:
    """User-facing reason a connection test failed.

    Unlike ``classify_provider_error`` this never echoes the exception text,
    which can carry internal URLs or response bodies; that goes to the log.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in (401, 403):
            return "AI provider rejected credentials"
        if code == 404:
            return "No OpenAI-compatible API at this URL (HTTP 404)"
        return f"AI provider HTTP {code}"
    if isinstance(exc, httpx.TimeoutException):
        return "AI provider request timed out"
    if isinstance(exc, httpx.RequestError):
        return "Could not reach AI provider"
    return "Unexpected response from the AI provider (see the server log)"


def test_connection(
    target: Target = "chat",
    base_url: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    """Probe an endpoint and list its models, for Settings and the wizard.

    ``base_url`` None tests the saved connection. A blank or masked key reuses
    the saved key only when the URL is the saved one, so a stored key is never
    sent to a different host.
    """
    invalidate_resolved_url()
    saved = chat_connection() if target == "chat" else _embed_endpoint()
    url = normalize_base_url(base_url) if base_url is not None else ""
    if not url:
        if saved is None:
            return {"ok": False, "base_url": None, "detail": "No URL set"}
        url = saved.base_url
    key = (api_key or "").strip()
    if not key or is_masked_key(key):
        key = saved.api_key if saved is not None and saved.base_url == url else ""
        key = env_key_for(url) or key
    conn = Connection(url, key)
    provider = OpenAICompatProvider(conn, timeout=10.0)
    try:
        models = provider.list_models()
    except Exception as exc:
        logger.warning("AI provider connection test failed", exc_info=True)
        return {"ok": False, "base_url": url, "detail": _connection_error_detail(exc)}
    try:
        embedding_models = provider.list_embedding_models()
    except Exception:
        logger.debug("embedding model list unavailable", exc_info=True)
        embedding_models = []
    kind = connection_kind(conn)
    return {
        "ok": True,
        "base_url": url,
        "kind": kind,
        "detail": f"Connected ({len(models)} models)",
        "models": models,
        "embedding_models": embedding_models,
        "presets": openrouter_preset_list() if kind == "openrouter" else [],
    }


def openrouter_preset_list() -> list[dict[str, str]]:
    return [
        {"id": "budget", "label": "Budget", "model": OPENROUTER_PRESETS["budget"]},
        {"id": "best", "label": "Best", "model": OPENROUTER_PRESETS["best"]},
    ]


def _detect_candidates() -> list[tuple[str, str]]:
    """(label, root URL) pairs where a local AI server commonly listens."""
    in_docker = os.path.exists("/.dockerenv")
    hosts = ["host.docker.internal", "127.0.0.1"] if in_docker else ["127.0.0.1"]
    ports = (("Ollama", 11434), ("LM Studio", 1234), ("llama.cpp", 8080))
    out: list[tuple[str, str]] = []
    if in_docker:
        out.append(("Ollama (compose service)", "http://ollama:11434"))
    for host in hosts:
        for label, port in ports:
            out.append((label, f"http://{host}:{port}"))
    return out


def detect_local_servers() -> list[dict[str, Any]]:
    """Probe the usual local addresses for an OpenAI-compatible server."""

    def probe(item: tuple[str, str]) -> dict[str, Any] | None:
        label, root = item
        conn = Connection(normalize_base_url(root))
        if not OpenAICompatProvider(conn).ping(timeout=_DETECT_TIMEOUT, strict=True):
            return None
        is_ollama = OllamaAdmin(root, timeout=_DETECT_TIMEOUT).ping()
        return {
            "label": label,
            "base_url": conn.base_url,
            "kind": "ollama" if is_ollama else "openai_compatible",
        }

    candidates = _detect_candidates()
    with ThreadPoolExecutor(max_workers=len(candidates)) as pool:
        found = list(pool.map(probe, candidates))
    return [row for row in found if row is not None]


def finish_legacy_ollama_detect() -> None:
    """Find the Ollama address an upgraded install used to auto-discover.

    Before connection_version 2 an empty Ollama URL meant "try the compose
    service, then the host". The migration cannot probe, so it leaves
    ``autodetect_ollama`` set and this fills the URL in, at startup and then
    from the AI timer loop until a server answers. Setting a URL in Settings
    clears the flag, and a field that has a URL is never overwritten.
    """
    ai = app_settings.ai_settings()
    target = str(ai.get("autodetect_ollama") or "")
    if target not in ("chat", "embed"):
        return
    field_name = "base_url" if target == "chat" else "embed_base_url"
    key_field = "api_key" if target == "chat" else "embed_api_key"
    if ai.get(field_name):
        app_settings.save({"ai": {"autodetect_ollama": ""}})
        return
    for row in detect_local_servers():
        if row["kind"] == "ollama":
            app_settings.save(
                {
                    "ai": {
                        field_name: row["base_url"],
                        key_field: "",
                        "autodetect_ollama": "",
                    }
                }
            )
            invalidate_resolved_url()
            logger.info("Found Ollama at %s for AI %s", row["base_url"], target)
            return
    logger.info(
        "Ollama was set to auto-discover but no server answered yet; "
        "set its address in Settings → AI"
    )
