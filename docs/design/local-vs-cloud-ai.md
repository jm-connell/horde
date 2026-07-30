# Local vs cloud AI

AI in Horde is **optional**. Downloads, library browse, and playback work without Ollama or OpenRouter. When enabled, the stack splits work between **local** (Ollama) and **cloud** (OpenRouter) providers with an explicit scope switch.

## Providers at a glance

| Provider | Typical role | Needs |
|----------|--------------|--------|
| **Ollama** | Embeddings, chat/tags/duplicates/recommendations on your GPU/CPU | Reachable Ollama URL; models pulled locally |
| **OpenRouter** | Cloud LLM for summaries, chat, tags, duplicates (and optionally embeddings) | API key; network egress; optional budget caps |

Configure both under [Settings → AI](../settings/ai.md). Ops detail: [AI setup](../ops/ai-setup.md).

## OpenRouter scope: `specialized` vs `all`

| Scope | Meaning |
|-------|---------|
| **specialized** (default) | OpenRouter handles LLM-style tasks; **embeddings stay local** when Ollama is available |
| **all** | OpenRouter may also own embedding / invent-vector work (cloud embed model) |

Even with scope `all`, you can prefer Ollama for embeddings when it is up (`ollama_prefer_embeddings`). That keeps semantic search vectors on hardware you control while still using a strong cloud chat model.

## Privacy

| Path | What leaves your LAN |
|------|----------------------|
| Ollama only | Titles, descriptions, notes, subtitle excerpts, prompts — stay on the Ollama host |
| OpenRouter specialized | LLM prompts/responses for enabled features (summaries, chat, tag enrich, duplicate scoring, etc.) |
| OpenRouter all | Same as specialized, plus embedding inputs if cloud embeddings are used |

!!! warning "Homelab realism"
    If you enable OpenRouter, assume text metadata and selected subtitle/note chunks can leave your network. Do not put secrets in video notes. Review OpenRouter’s terms and your own threat model.

Horde can show per-response cost chips and enforce a soft/hard weekly USD budget for OpenRouter so surprise bills stay visible.

## Why embeddings are often local

Semantic search, related videos, and recommendation shelves depend on **embedding** the library. That workload is:

- High volume (every video, sometimes chunked subtitles)
- Sensitive if your archive titles/notes are private
- Well served by small local models (`nomic-embed-text`, `mxbai-embed-large`, `all-minilm`) that fit modest VRAM — see [Workload profiles](workload-profiles.md)

Keeping embeddings on Ollama while using a cloud LLM for prose is the usual “best of both” setup (`specialized` scope).

## Workload and single-flight

Local GPUs are scarce on a NAS. Horde sizes models and invent intensity by VRAM tier ([workload profiles](workload-profiles.md)) and runs AI jobs **one at a time** ([single-flight AI](single-flight-ai.md)) so chat and embedding do not thrash each other.

## Related

- [AI features](../guides/ai-features.md)
- [AI pipeline](../architecture/ai-pipeline.md)
- [Settings split](settings-split.md) — API keys live in server `ai` settings
