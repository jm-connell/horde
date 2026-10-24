# Local vs cloud AI

AI in Horde is **optional**. Downloads, library browse, and playback work without it. When enabled, Horde talks to **one OpenAI-compatible endpoint** for chat and, unless you split them, for embeddings too. That endpoint can be a cloud provider or a server you run; Horde treats them the same ([ADR 0017](../adr/0017-openai-compatible-provider.md)).

## Choices at a glance

| Setup | Chat | Embeddings | Needs |
|-------|------|------------|--------|
| **Cloud only** (e.g. OpenRouter, OpenAI, Gemini) | Cloud | Cloud | API key; network egress; optional budget caps |
| **Local only** (Ollama, LM Studio, llama.cpp, vLLM) | Your GPU/CPU | Your GPU/CPU | A reachable server; models installed (Ollama: downloaded for you) |
| **Split** | Cloud | Local (second server) | Both; keeps the high-volume, library-wide embedding work on your hardware |

Configure under [Settings → AI](../settings/ai.md). Ops detail and Docker networking: [AI setup](../ops/ai-setup.md).

## Privacy

| Path | What leaves your LAN |
|------|----------------------|
| Local only | Nothing: titles, descriptions, notes, subtitle excerpts and prompts stay on your server |
| Cloud chat, local embeddings | Prompts and replies for enabled features (summaries, chapters, chat, tag enrich, duplicate scoring, category names) |
| Cloud only | The above, plus every embedding input (titles, descriptions, subtitle chunks) |

!!! warning "Homelab realism"
    With a cloud provider, assume text metadata and selected subtitle/note chunks leave your network. Do not put secrets in video notes. Review the provider's terms and your own threat model.

When the provider reports cost per call (OpenRouter), Horde shows per-response cost chips and can enforce a soft/hard weekly USD budget so surprise bills stay visible.

## Why embeddings are often local

Semantic search, related videos, and recommendation shelves depend on **embedding** the library. That workload is:

- High volume (every video, sometimes chunked subtitles)
- Sensitive if your archive titles/notes are private
- Well served by small local models (`nomic-embed-text`, `mxbai-embed-large`, `all-minilm`) that fit modest VRAM — see [Workload profiles](workload-profiles.md)

Keeping embeddings on a local Ollama while using a cloud model for prose is the usual "best of both" setup: turn on **Use a different server for embeddings**. It is also the only way to get search with chat providers that have no embeddings API (Groq, DeepSeek, Anthropic).

## Workload and single-flight

Local GPUs are scarce on a NAS. On Ollama, Horde sizes models by VRAM tier ([workload profiles](workload-profiles.md)) and runs AI jobs **one at a time** ([single-flight AI](single-flight-ai.md)) so chat and embedding do not thrash each other.

## Related

- [AI features](../guides/ai-features.md)
- [AI pipeline](../architecture/ai-pipeline.md)
- [Settings split](settings-split.md) — API keys live in server `ai` settings
