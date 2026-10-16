# AI pipeline

Background and on-demand AI for search, tags, chat, recommendations, and catalogs.

## Job kinds (`ai_jobs`)

| Kind | Worker behavior |
|------|-----------------|
| `embed_video` | Build/store embeddings for a library video |
| `enrich_tags` | LLM tag enrichment into `video_ai_meta` / `videos.tags` |
| `refresh_categories` | Rebuild `ai_categories` shelves |
| `embed_catalog_video` | Embed a channel-catalog upload |
| `summarize` | Generate a Watch summary from captions (after download) |
| `chapters` | Generate Watch chapter markers from a timed transcript (after download when `ai_chapters_mode` is `on_download`, or from Watch) |

The worker is single-flight with up to **3 attempts** and `run_after` backoff ([Workers](workers.md), [Single-flight AI](../design/single-flight-ai.md)).

### Job outcomes

| Status | Meaning |
|--------|---------|
| `queued` | Waiting (may be deferred via `run_after`, or waiting on a provider) |
| `running` | Claimed by the single-flight worker |
| `completed` | Finished successfully |
| `cancelled` | Soft skip (e.g. `needs_review`, `tags_locked`, `empty_document`) or user cancel — **does not** burn retry attempts as a failure |
| `error` | Terminal after 3 failed attempts — retry from Settings → AI → Jobs |

### Status fields (`GET /api/ai/status`)

Beyond readiness and `queue_depth`, status exposes:

| Field | Purpose |
|-------|---------|
| `blocked_reason` | Why nothing is running (paused, provider unreachable, OpenRouter budget hard limit) |
| `runnable_count` | Queued jobs due now with a provider available |
| `deferred_count` | Queued with future `run_after` (retry backoff) |
| `waiting_count` | Queued but provider missing for that kind |
| `error_count` / `recent_failures` | Terminal failures for Jobs UI |
| `current_job` | Includes `id`, `attempts`, prior `error` when retrying |

Members see a reduced view: `GET /api/ai/status`, `GET /api/health` and the `ai` block of `GET /api/settings` keep the readiness flags and feature switches the player and library read, but leave out the provider type and address, schedule, workload profile, model names, GPU details, key tail, budget and error texts; `GET /api/health` has no `openrouter` block for them (administrators get everything). `GET /api/ai/jobs` is administrator-only.

A chat stream also ends when its caller loses access (session revoked, account disabled or deleted): the server stops reading from the provider, which drops the upstream request. The cost of that cut-off turn is not booked in the ledger, because the provider only reports it in a final usage chunk (a client that disconnects mid-answer loses it the same way).

Health (`GET /api/health`) mirrors `workers.ai_error_count` and `workers.ai_blocked_reason`.

### Job admin API

| Endpoint | Action |
|----------|--------|
| `GET /api/ai/jobs` | List recent jobs (`status`, `limit`) |
| `POST /api/ai/jobs/{id}/retry` | Requeue `error` / `cancelled` |
| `POST /api/ai/jobs/retry-failed` | Bulk retry terminal errors |
| `POST /api/ai/jobs/{id}/cancel` | Cancel a queued job |
| `POST /api/ai/jobs/clear-failed` | Delete old `error` / `cancelled` rows |

!!! important "Duplicate LLM scoring is on-demand"
    Heuristic duplicate **groups** and optional **LLM confirmation scores** run **on-demand** from the **Import / review API** (`duplicate_groups` + `annotate_group`). There is no background batch job for duplicates. Annotate failures surface as `ai_error` on the group payload.

## Provider routing

Resolved from Settings + env (`OLLAMA_BASE_URL`, `OPENROUTER_API_KEY`):

| Concern | Typical routing |
|---------|-----------------|
| Embeddings | Ollama embed model, or OpenRouter when scope is **all** (unless `ollama_prefer_embeddings`) |
| Chat / summary / tags / chapters | OpenRouter when enabled + specialized/all; else Ollama chat model |
| Workload models | VRAM tier defaults from [AI setup](../ops/ai-setup.md) |

When Ollama HTTP calls fail, the resolved URL cache is invalidated so a dead cache cannot keep claiming jobs. Queued jobs that cannot run yet stay `queued` (attempts unchanged) and may show a `waiting: …` note after ~2 minutes.

Embeds are only enqueued when Ollama is **enabled** or OpenRouter owns embeddings (`scope=all`) — not when neither backend can ever serve them.

## Vector search

Similarity search (hybrid search, related videos, recommendations) scores every stored chunk with one matrix product. The vectors are loaded into an L2-normalised `float32` matrix per dimension, built on first use and then updated incrementally: each search compares a cheap per-video fingerprint (chunk count and max id) and the videos the ORM reported as written, and re-reads only the videos that changed (a full rebuild only when more than 20 percent of the videos, and more than 50, changed at once). The code is `services/ai/vector_index.py`; see [ADR 0007](../adr/0007-fts5-triggers-and-vector-index.md). Memory is about `chunks x dim x 4` bytes, for example 60 000 chunks of 768 dimensions is roughly 184 MB. The matrix lives on the database engine object, not in module state. Vectors of another dimension (a previous embed model) are ignored until re-indexed.

## Embeddings layout

`video_embeddings.chunk_index`:

| Index | Content |
|-------|---------|
| **-1** | Metadata document (title, channel, description, tags, …) |
| **0+** | Caption / subtitle chunks (when `use_subtitles` is on) |

Changing the embed model invalidates compatibility — reindex so all rows share the new model id.

`video_ai_meta` tracks `embed_status` (`pending` / `ready` / `error`) and `embed_error` (last failure). Empty usable corpus (no metadata/subtitle text) sets `error` + `empty_document` rather than a silent “ready” with zero vectors. Both fields are exposed on `VideoRead`.

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
