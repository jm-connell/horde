# AI

Controls under **Settings → AI** (`?tab=ai`). Deep-link panes with `?pane=providers`, `?pane=features`, or `?pane=jobs`.

All AI preferences live in the top-level **`ai`** object in `app_settings.json` (see [All settings](all-settings.md#ai_defaults)). They are **not** part of the client `ui` blob.

!!! tip "Setup guide"
    For install, models, and networking, see [AI setup](../ops/ai-setup.md) and [Local vs cloud AI](../design/local-vs-cloud-ai.md).

## Providers (`?pane=providers`)

One connection to any OpenAI-compatible endpoint serves chat, and embeddings unless they get their own. See [AI setup](../ops/ai-setup.md#which-url-do-i-type-docker-networking) for which URL to type.

### General

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Workload | `workload_profile` | `"normal"` | `light` \| `normal` \| `heavy` — how hard Horde works (sample sizes, batches); on Ollama it also picks GPU-sized models |

### Provider

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Enable AI | `enabled` | `true` | Master switch; AI also needs a URL |
| API key or server URL | `base_url` | `""` | One field. A key from OpenRouter, OpenAI, Gemini or Groq fills in its provider's URL; anything else is an OpenAI-compatible base URL (a bare `host:port` gets `http://` and `/v1`). Connecting shows the provider found (by host, or Ollama by probe) |
| API key | `api_key` | `""` | Shown for a URL (for servers that need one). Stored server-side; read back masked (`api_key_set`). Dropped when the URL changes without a new key, so it never goes to another host |
| Connect / Test | — | — | Lists the server's models and saves the URL and key |
| Find a server on this machine | — | — | Probes the bundled Ollama and ports 11434 / 1234 / 8080 on the Docker host |

### Models

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Chat model | `chat_model` | `""` | Summaries, chapters, chat, tags, categories, duplicates. A list when the server lists its models (OpenRouter rows show USD per 1M tokens and Budget / Best presets), otherwise typed |
| Embedding model | `embed_model` | `""` | Semantic search, related videos, category shelves. Empty = those stay off. Changing it offers to rebuild the indexes |
| Use a different server for embeddings | `embed_base_url`, `embed_api_key` | `""` | Empty = embeddings use the chat connection. For providers without `/v1/embeddings` (Groq, DeepSeek, Anthropic) |
| Show costs in Watch | `show_costs` | `false` | Only shown when the provider reports cost (OpenRouter) |

### Ollama

Shown when the chat or embeddings URL is an Ollama server.

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Download recommended models | — | — | Applies the workload: picks models for the GPU and downloads them |
| Download missing models | `auto_pull_models` | `true` | Download configured models Ollama does not have |
| Ollama VRAM (GB) | `vram_gb` | `null` | Optional; clamp ~0.5–256. Blank = autodetect on the Ollama host |

### Costs

Shown when the provider reports a cost per call (OpenRouter).

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Weekly budget (USD) | `weekly_budget_usd` | `null` | Warns over rolling 7 days; `null` = off (~$0.01–$100000) |
| Stop AI calls when exceeded | `budget_hard_limit` | `false` | Blocks further calls and pauses the AI queue when spend ≥ budget |

Backend-only: `connection_version` (settings shape, for the one-time upgrade) and `autodetect_ollama` (an upgraded install still looking for its Ollama; cleared when you set a URL).

## Features (`?pane=features`)

| Setting | Key | Default | Range / values |
|---------|-----|---------|----------------|
| Use subtitles in search indexes | `use_subtitles` | `true` | Include captions in embeds: search matches single passages; related videos and categories weigh them below the metadata |
| AI video summaries | `ai_summaries` | `true` | After download when captions exist; regenerate on Watch |
| AI video chapters | `ai_chapters` | `true` | Enable caption-based chapter markers |
| Generate chapters | `ai_chapters_mode` | `"on_download"` | `on_download` queues after download; `on_watch` is a Watch-page button |
| AI video chat | `ai_chat` | `true` | Ask-the-video on Watch |
| Summary length | `summary_length` | `"short"` | `short` \| `medium` \| `long` |
| Category match strictness | `category_min_score` | `0.55` | 0.2–0.9; a video must also fit the category nearly as well as its best one |
| Enrich tags with LLM | `enrich_tags` | `true` | Suggest tags after download (skipped if you edit tags manually) |
| Re-check tags after (days) | `tag_rescan_days` | `90` | 7–365 |
| AI duplicate confirmation | `ai_duplicates` | `true` | LLM assist when reviewing import duplicates |

Summary length guide: short ≈75–120 words, medium ≈200–280, long ≈300–400. Medium/long pull more caption context.

## Jobs (`?pane=jobs`)

### Queue

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Paused | `paused` | `false` | Pause/resume from the Jobs pane or System background activity |

Live queue status appears here and on System:

- Indexed count and **runnable / deferred / waiting / failed** breakdown
- **Blocked** state + reason when jobs cannot run (provider down, paused, budget hard limit)
- Current job (with attempt number when retrying)
- **Failed jobs** list with Retry, Retry all, Clear failed
- **Provider** kind and chat model, and, when the provider reports cost, **Spend** (24h / 7-day totals from the local usage ledger, weekly budget if set, 24h call count)

### Automatic schedule

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Schedule | `schedule` | `"on_download"` | When Horde queues AI work on its own |
| Timer hours | `timer_hours` | `6` | Used when schedule is `timer` |
| Schedule time | `schedule_time` | `"03:00"` | Local `HH:MM` when schedule is `set_time` |

| Schedule value | Behavior |
|----------------|----------|
| `on_download` | Embed and enrich tags when a download finishes; also queues missing search indexes when the GPU job queue is idle |
| `on_request` | No automatic work — use Run now / process actions |
| `timer` | Periodically index videos missing search indexes |
| `set_time` | Run once per day at `schedule_time` |

Backend-only bookkeeping: `last_daily_run` (`YYYY-MM-DD` when `set_time` last ran) — not shown as an editable control.

### Catch-up & process actions

| Action | Label | What it queues |
|--------|--------|----------------|
| `all_recent` | Process recent | Missing search indexes + AI tags for videos watched/added in the last 30 days, then refresh categories |
| `all_full` | Process full library | Same across the whole library, then categories |
| `embeds` | Index missing videos | Search indexes for missing/stale/wrong-model embeds |
| `reindex_embeds` | Rebuild search indexes | Force re-queue indexing; prefer after changing embed model |
| `missing_tags` | Enrich missing tags | Chat model tags only where AI tags are absent |
| `full_tags` | Re-tag entire library | Re-run enrichment for every unlocked video |
| `categories` | Refresh categories | Invent browse categories, rematch shelves via indexes |

`pending_category_refresh` is a backend flag set when a category refresh should run after indexing — not a Settings toggle.

Duplicate LLM scoring is **on-demand** during Import when `ai_duplicates` is enabled — there is no batch Settings job for duplicates.

## See also

- [Settings overview](index.md) — `?tab` / `?pane` deep links
- [System](system.md) — AI provider status, AI queue in background activity
- [AI features (guide)](../guides/ai-features.md)
- [Workload profiles](../design/workload-profiles.md)
- [All settings](all-settings.md#ai_defaults)
