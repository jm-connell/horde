# AI

Controls under **Settings → AI** (`?tab=ai`). Deep-link panes with `?pane=providers`, `?pane=features`, or `?pane=jobs`.

All AI preferences live in the top-level **`ai`** object in `app_settings.json` (see [All settings](all-settings.md#ai_defaults)). They are **not** part of the client `ui` blob.

!!! tip "Setup guide"
    For install, models, and networking, see [AI setup](../ops/ai-setup.md) and [Local vs cloud AI](../design/local-vs-cloud-ai.md).

## Providers (`?pane=providers`)

### Local Ollama

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Enable AI / Ollama | `enabled` | `true` | Master switch for local AI |
| Provider | `provider` | `"ollama"` | Stored provider id |
| Base URL | `base_url` | `""` | Empty = default discovery / same-host; set for remote Ollama |
| Test connection | — | — | UI action against the configured base URL |
| Workload | `workload_profile` | `"normal"` | `light` \| `normal` \| `heavy` — how hard Horde works (sample sizes, batches), not which GPU |
| VRAM override (GiB) | `vram_gb` | `null` | Optional; clamp ~0.5–256. Blank = autodetect on Ollama host |
| Auto-pull models | `auto_pull_models` | `true` | Pull missing embed/chat models when needed |
| Embed model | `embed_model` | `"nomic-embed-text"` | Semantic search, related, categories |
| Chat model | `chat_model` | `"llama3.2:3b"` | Used when OpenRouter is off (tags, categories, local fallback) |
| Prefer Ollama embeddings | `ollama_prefer_embeddings` | `false` | When OpenRouter scope is `all`, still use Ollama for embeddings if available |

**Workload tip:** Light keeps invent samples and indexing queues small. Normal is balanced. Heavy uses larger invent samples, deeper subtitle context, and bigger index batches. Model picks follow the **Ollama machine’s** VRAM, not the Horde host CPU/GPU shown under System → Resources.

Common embed presets: `nomic-embed-text`, `mxbai-embed-large`, `all-minilm`, or custom. Chat presets include `llama3.2:3b` / `1b`, `qwen2.5:3b`–`14b`, `llama3.1:8b`, `phi3:mini`, or custom.

### OpenRouter

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Enable OpenRouter | `openrouter_enabled` | `false` | Cloud LLM backend |
| Scope | `openrouter_scope` | `"specialized"` | `specialized` = LLM tasks only; `all` = also embeddings |
| API key | `openrouter_api_key` | `""` | Stored server-side; UI shows set/cleared, not the raw secret after save |
| Chat model | `openrouter_model` | `"google/gemini-2.5-flash-lite"` | Presets: Budget / Best |
| Embed model | `openrouter_embed_model` | `"openai/text-embedding-3-small"` | When scope is `all` |
| Show costs | `openrouter_show_costs` | `false` | Per-response cost chips on Watch (Settings totals always show) |
| Weekly budget (USD) | `openrouter_weekly_budget_usd` | `null` | Soft limit over rolling 7 days; `null` = off (~$0.01–$100000) |
| Hard limit | `openrouter_budget_hard_limit` | `false` | When true and spend ≥ budget, block further OpenRouter calls |

## Features (`?pane=features`)

| Setting | Key | Default | Range / values |
|---------|-----|---------|----------------|
| Use subtitles in search indexes | `use_subtitles` | `true` | Include captions in embeds / related / categories |
| AI video summaries | `ai_summaries` | `true` | After download when captions exist; regenerate on Watch |
| AI video chat | `ai_chat` | `true` | Ask-the-video on Watch |
| Summary length | `summary_length` | `"short"` | `short` \| `medium` \| `long` |
| Category match strictness | `category_min_score` | `0.55` | 0.2–0.9 |
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
- [System](system.md) — Ollama/OpenRouter status, AI queue in background activity
- [AI features (guide)](../guides/ai-features.md)
- [Workload profiles](../design/workload-profiles.md)
- [All settings](all-settings.md#ai_defaults)
