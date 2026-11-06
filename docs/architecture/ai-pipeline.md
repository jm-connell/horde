# AI pipeline

Background and on-demand AI for search, tags, chat, recommendations, and catalogs.

## Job kinds (`ai_jobs`)

| Kind | Worker behavior |
|------|-----------------|
| `embed_video` | Build/store embeddings for a library video |
| `enrich_tags` | LLM tag enrichment into `video_ai_meta` / `videos.tags` |
| `refresh_categories` | Rebuild `ai_categories` shelves |
| `embed_catalog_video` | Embed a channel-catalog upload |
| `embed_kb_channel` | Embed one batch (25 videos) of an [Ask](../design/channel-knowledge.md) channel's passages, then queue the next. Picked only when no library job is runnable |
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

Similarity search scores every stored chunk with one matrix product: hybrid search takes each video's best chunk, while related videos and categories compare whole videos by a **profile**: the metadata vector (chunk `-1`) plus half the weight of the mean of its caption chunks, normalised. One caption passage that happens to match cannot pull in an unrelated video, and captions still count when the title and description say little. Profiles are cached per matrix; after the vectors change only the changed videos' profiles are recomputed. The vectors are loaded into an L2-normalised `float32` matrix per dimension, built on first use and then updated incrementally: each search compares a cheap per-video fingerprint (chunk count and max id) and the videos the ORM reported as written, and re-reads only the videos that changed (a full rebuild only when more than 20 percent of the videos, and more than 50, changed at once). The code is `services/ai/vector_index.py`; see [ADR 0007](../adr/0007-fts5-triggers-and-vector-index.md). Memory is about `chunks x dim x 4` bytes, for example 60 000 chunks of 768 dimensions is roughly 184 MB. Profiles add `videos x dim x 4` bytes (about 31 MB for 10 000 videos). The matrix lives on the database engine object, not in module state. Vectors of another dimension (a previous embed model) are ignored until re-indexed.

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
| **Recommend** | Category chips, the Recommended feed and related videos ([below](#recommendations)) |
| **Ask, about a video** | Retrieve the video's relevant caption chunks (plus details and saved comments), stream the reply (SSE) through `POST /api/ask/chat` into the user's Ask thread ([Channel knowledge](../design/channel-knowledge.md), [ADR 0029](../adr/0029-video-questions-in-ask.md)) |
| **Ask, from Horde** | BM25 over the shipped docs and source (`services/ai/help_chat.py`, built in memory on first use); the panel's `POST /api/ask/chat` streams the reply and saves both turns to the user's thread, and routes to channels instead when the question names one ([Channel knowledge](../design/channel-knowledge.md), [ADR 0028](../adr/0028-one-ask.md)); the older `POST /api/ai/help/chat` stores nothing ([ADR 0018](../adr/0018-help-chat-retrieval.md)). Links and actions are `[[...]]` tokens checked against `help_catalog.json` (served at `GET /api/ai/help/catalog`) and applied by the client only on a click; `help_data.py` adds the user's own data when allowed, `help_model.py` the model's strength ([ADR 0021](../adr/0021-help-chat-acts-through-confirmed-tokens.md)) |
| **Cost ledger** | `openrouter_usage` + weekly budget / hard limit ([cost_ledger](../ops/ai-setup.md#costs-and-the-weekly-budget)) |

## Recommendations

The category rule lives in `services/ai/recommend.py`, related videos in `services/library.related_videos` (both score videos by their profiles), and the Recommended feed in `services/discovery/`.

- **Categories** (`refresh_categories`): the chat model reads a numbered sample of the library (recent watches, recent downloads, then one video per channel) and proposes 8-15 categories, each with the numbers of 3-8 sample videos that belong in it. When the model follows that format, a category with fewer than two valid examples is dropped as a guess; models that ignore it fall back to picking examples by embedding. A category's vector blends the embedded name, blurb and example titles (40%) with the mean of its examples' vectors (60%). A video (or, in the Recommended feed, any pick with an embedding) then joins a category only when it clears the floor (0.35), scores within 0.04 of **its own best category**, and either clears `category_min_score` or is within 0.08 of the category's top match. The competition is what keeps a shelf from filling with videos that belong somewhere else; with embed models whose unrelated texts already score high (such as `nomic-embed-text`) it does most of the filtering and `category_min_score` matters little.
- **More like this** (`GET /api/videos/{id}/related`): neighbours of the video's profile, plus 0.05 for the same channel and up to 0.08 for shared tags (rare tags count more than tags most of the library has), minus 0.05 for videos the viewer has already watched. Every page re-ranks the same 200 nearest neighbours, so pages continue one ranking; same-channel, shared-tag and random videos fill in when AI is off or the ranking runs out.
- **Recommended** (`services/discovery/`, `GET /api/discover/feed`, the home page's Recommended tab): the library, every catalog and videos a background gatherer found on YouTube, sorted into four buckets (subscriptions, similar, new channels, throwbacks) and mixed 30/30/25/15, with channel spacing, caps, a calibrated relevance scale and seeded variety. The gatherer, its YouTube budget and every tuning choice are in [ADR 0019](../adr/0019-recommended-plus.md); why it is the only Recommended tab, [ADR 0026](../adr/0026-one-recommended-tab.md).
- **Tags** (`enrich_tags`): the prompt lists the library's most used tags so the model reuses them, and a suggestion that differs from one only in case takes the library's spelling. Consistent tags make the shared-tag boost and tag chips more useful.

## Related

- [AI setup](../ops/ai-setup.md)
- [AI features](../guides/ai-features.md)
- [Data model](data-model.md)
- [Single-flight AI](../design/single-flight-ai.md)
