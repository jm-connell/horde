# AI pipeline

Background and on-demand AI for search, tags, chat, recommendations, and catalogs.

## Job kinds (`ai_jobs`)

| Kind | Worker behavior |
|------|-----------------|
| `embed_video` | Build/store embeddings for a library video |
| `enrich_tags` | LLM tag enrichment into `video_ai_meta` / `videos.tags` |
| `refresh_categories` | Rebuild `ai_categories` shelves |
| `embed_catalog_video` | Embed a channel-catalog upload |

The worker is single-flight with retries ([Workers](workers.md)).

!!! important "Duplicate LLM scoring is on-demand"
    Heuristic duplicate **groups** and optional **LLM confirmation scores** run **on-demand** from the **Import / review API** (`duplicate_groups` + `annotate_group`). There is no background batch job for duplicates.

## Provider routing

Resolved from Settings + env (`OLLAMA_BASE_URL`, `OPENROUTER_API_KEY`):

| Concern | Typical routing |
|---------|-----------------|
| Embeddings | Ollama embed model, or OpenRouter when scope is **all** (unless `ollama_prefer_embeddings`) |
| Chat / summary / tags | OpenRouter when enabled + specialized/all; else Ollama chat model |
| Workload models | VRAM tier defaults from [AI setup](../ops/ai-setup.md) |

## Embeddings layout

`video_embeddings.chunk_index`:

| Index | Content |
|-------|---------|
| **-1** | Metadata document (title, channel, description, tags, …) |
| **0+** | Caption / subtitle chunks (when `use_subtitles` is on) |

Changing the embed model invalidates compatibility — reindex so all rows share the new model id.

## Product features

| Feature | Mechanism |
|---------|-----------|
| **Hybrid search** | Keyword + embedding similarity over library (and catalog) vectors |
| **Recommend** | Category chips + similarity / invent prompts scaled by workload |
| **Chat RAG** | Retrieve relevant chunks, stream assistant reply (SSE) |
| **Cost ledger** | `openrouter_usage` + weekly budget / hard limit ([cost_ledger](../ops/ai-setup.md#weekly-budget)) |

## Related

- [AI setup](../ops/ai-setup.md)
- [AI features](../guides/ai-features.md)
- [Data model](data-model.md)
- [Single-flight AI](../design/single-flight-ai.md)
