# 0017. One OpenAI-compatible AI provider instead of Ollama plus OpenRouter

Status: Accepted

## Context

Horde had two AI backends wired in by name: Ollama's native API (`/api/chat`, `/api/embeddings`, auto-discovered at a few fixed addresses) for embeddings and local chat, and OpenRouter for cloud chat, with a scope switch (`specialized` / `all`) and an override (`ollama_prefer_embeddings`) deciding which one did what. Any other provider (OpenAI, Gemini, Groq, LM Studio, llama.cpp, vLLM) needed new code. Nearly every one of them, Ollama included, also serves the OpenAI API under `/v1`, and Horde's OpenRouter client already spoke that API.

## Decision

- **One client for the OpenAI API** (`OpenAICompatProvider` in `services/ai/provider.py`): `/models`, `/chat/completions` (with streaming), `/embeddings`. Settings hold a base URL, an optional API key and the chat and embedding model ids; a bare `http://host:port` gets `/v1`.
- **An optional second connection for embeddings** (`embed_base_url`, `embed_api_key`). It replaces the scope switch, and serves providers with no embeddings API (Groq, DeepSeek, Anthropic). An empty embedding model turns search indexes off.
- **Provider extras by detection, not configuration.** OpenRouter (by host) gets its request field for usage, its attribution headers, model prices and the Budget/Best presets; cost is recorded only when a response carries `usage.cost`, so the budget applies only there. Ollama (its host answers `/api/version`) keeps model download, presence checks and GPU-sized model picks through a small native helper (`OllamaAdmin`); chat and embeddings still go through `/v1`.
- **The bundled Ollama stays optional** (compose profile `ai`); the setup wizard's "Run Ollama for me" points Horde at it and downloads GPU-sized models. Horde does not start containers.
- **A saved key never follows a URL change.** Changing a URL without a new key clears the stored key; the connection test only reuses a saved key for its own URL; `OPENROUTER_API_KEY` is only sent to OpenRouter.
- **Old settings are converted once** (`connection_version` 2) with the same model ids, so stored embeddings still match. The one case the conversion cannot settle offline, an Ollama URL left empty for auto-discovery, is finished at startup by probing the old candidates.

## Consequences

- Any OpenAI-compatible endpoint works for chat and embeddings without code changes; the Settings page is one form with a preset list instead of two panes.
- Horde no longer auto-discovers Ollama on a fresh install: the wizard or Settings sets the URL (with a "find a server on this machine" probe).
- Ollama runs through its OpenAI layer, so Ollama-only request options (`num_ctx`, keep-alive) are not available; Horde did not use them.
- Providers that report no cost show no spend, and their calls are not in the cost ledger.
- `/api/ai/openrouter/*` are gone: `/api/ai/test` (probe and list models), `/api/ai/detect` and `/api/ai/costs` replace them, and `/api/health` reports one `ai` block instead of `ollama` and `openrouter`.
