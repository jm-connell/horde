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
| `blocked_reason` | Why nothing is running (paused, provider unreachable, weekly budget hard limit) |
| `runnable_count` | Queued jobs due now with a provider available |
| `deferred_count` | Queued with future `run_after` (retry backoff) |
| `waiting_count` | Queued but provider missing for that kind |
| `error_count` / `recent_failures` | Terminal failures for Jobs UI |
| `current_job` | Includes `id`, `attempts`, prior `error` when retrying |

Members see a reduced view: `GET /api/ai/status`, `GET /api/health` and the `ai` block of `GET /api/settings` keep the readiness flags and feature switches the player and library read, but leave out the provider type and address, schedule, workload profile, model names, GPU details, key tail, budget and error texts; `GET /api/health` has no `openrouter` block for them (administrators get everything). Video reads give them "AI indexing failed" instead of the embedding error and no summary model or cost, and `GET /api/system/activity` leaves out the engine, detail (model names) and error of AI jobs and model pulls ([what members see](../ops/authentication.md#account-types-and-permissions)). `GET /api/ai/jobs` is administrator-only.

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

One OpenAI-compatible client (`services/ai/provider.py`, [ADR 0017](../adr/0017-openai-compatible-provider.md)) resolved from Settings (`base_url`, `api_key`, `chat_model`, `embed_base_url`, `embed_api_key`, `embed_model`) and env (`OPENROUTER_API_KEY`; `OLLAMA_BASE_URL` as a legacy fallback):

| Concern | Routing |
|---------|---------|
| Chat / summary / tags / chapters | `/chat/completions` on the chat connection |
| Embeddings | `/embeddings` on `embed_base_url` when set, else on the chat connection; none when `embed_model` is empty |
| Cost | Recorded when the response carries `usage.cost` (OpenRouter) |
| Model downloads, VRAM sizing | Only when the endpoint's host answers Ollama's `/api/version` |
| Workload models | VRAM tier defaults from [AI setup](../ops/ai-setup.md) (Ollama only) |

Reachability (`GET /models`) is cached per URL; a failed call drops the cache so a dead endpoint cannot keep claiming jobs, and a failure is retried after 30 s. Queued jobs that cannot run yet stay `queued` (attempts unchanged) and may show a `waiting: …` note after ~2 minutes.

Embeds are only enqueued when an embedding model and endpoint are set; tags, summaries and chapters only when a chat model and endpoint are set.

## Vector search

Similarity search scores every stored chunk with one matrix product: hybrid search takes each video's best chunk, while related videos, "For you" and category shelves compare whole videos by a **profile**: the metadata vector (chunk `-1`) plus half the weight of the mean of its caption chunks, normalised. One caption passage that happens to match cannot pull in an unrelated video, and captions still count when the title and description say little. Profiles are cached per matrix; after the vectors change only the changed videos' profiles are recomputed. The vectors are loaded into an L2-normalised `float32` matrix per dimension, built on first use and then updated incrementally: each search compares a cheap per-video fingerprint (chunk count and max id) and the videos the ORM reported as written, and re-reads only the videos that changed (a full rebuild only when more than 20 percent of the videos, and more than 50, changed at once). The code is `services/ai/vector_index.py`; see [ADR 0007](../adr/0007-fts5-triggers-and-vector-index.md). Memory is about `chunks x dim x 4` bytes, for example 60 000 chunks of 768 dimensions is roughly 184 MB. Profiles add `videos x dim x 4` bytes (about 31 MB for 10 000 videos). The matrix lives on the database engine object, not in module state. Vectors of another dimension (a previous embed model) are ignored until re-indexed.

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
| **Recommend** | Category chips + "For you" + related videos ([below](#recommendations)) |
| **Chat RAG** | Retrieve relevant chunks, stream assistant reply (SSE) |
| **Cost ledger** | `openrouter_usage` + weekly budget / hard limit ([cost_ledger](../ops/ai-setup.md#costs-and-the-weekly-budget)) |

## Recommendations

The rankings live in `services/ai/recommend.py` and `services/library.related_videos`, and score videos by their profiles.

- **Categories** (`refresh_categories`): the chat model reads a numbered sample of the library (recent watches, recent downloads, then one video per channel) and proposes 8-15 categories, each with the numbers of 3-8 sample videos that belong in it. When the model follows that format, a category with fewer than two valid examples is dropped as a guess; models that ignore it fall back to picking examples by embedding. A category's vector blends the embedded name, blurb and example titles (40%) with the mean of its examples' vectors (60%). A video then joins a category only when it clears the floor (0.35), scores within 0.04 of **its own best category**, and either clears `category_min_score` or is within 0.08 of the category's top match. The competition is what keeps a shelf from filling with videos that belong somewhere else; with embed models whose unrelated texts already score high (such as `nomic-embed-text`) it does most of the filtering and `category_min_score` matters little.
- **For you**: seeded from the viewer's 30 most recent watches. Each seed is weighted by recency (0.93 per step back) and by how far the viewer got (finished or past halfway counts fully, opened and abandoned counts about a third). A video's score is 75% its best weighted seed match and 25% its weighted average match across all seeds, plus a small boost for channels the viewer follows. Videos the viewer has watched are left out of the ranked part; one channel's repeated picks are pushed down so a single channel cannot fill the shelf. Unscored videos follow by recency, then the viewer's watched videos, so infinite scroll still reaches the whole library. Without an embedding provider (or before any watched video has vectors) the same shelf is ranked from the history alone (`_taste` in `services/ai/recommend.py`): 45% how much the viewer watches the channel (recency 0.97 per step, weighted by engagement, over the last 200 watches), 25% the three strongest tags it shares with watched videos, 15% a followed channel and 15% freshness (halving every 30 days). With `include_streams` the newest 30 indexed, not-downloaded uploads of each followed channel join the ranking: scored by their catalog embeddings with AI, by the same taste formula without it, so they merge with library videos on one scale.
- **More like this** (`GET /api/videos/{id}/related`): neighbours of the video's profile, plus 0.05 for the same channel and up to 0.08 for shared tags (rare tags count more than tags most of the library has), minus 0.05 for videos the viewer has already watched. Every page re-ranks the same 200 nearest neighbours, so pages continue one ranking; same-channel, shared-tag and random videos fill in when AI is off or the ranking runs out.
- **Tags** (`enrich_tags`): the prompt lists the library's most used tags so the model reuses them, and a suggestion that differs from one only in case takes the library's spelling. Consistent tags make the shared-tag boost and tag chips more useful.

## Related

- [AI setup](../ops/ai-setup.md)
- [AI features](../guides/ai-features.md)
- [Data model](data-model.md)
- [Single-flight AI](../design/single-flight-ai.md)
