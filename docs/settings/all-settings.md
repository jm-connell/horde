# All settings appendix

Exhaustive reference for defaults in `backend/app/services/app_settings.py` (`DEFAULTS`, `AI_DEFAULTS`) and the frontend `Settings` / `SERVER_UI_KEYS` in `frontend/src/hooks/useSettings.ts`.

**Storage layers**

| Layer | Meaning |
|-------|---------|
| **Top-level** | Root keys in `DATA_DIR/app_settings.json` |
| **AI** | Nested `ai` object in that file |
| **UI blob** | Nested `ui` object; keys synced from `SERVER_UI_KEYS` (snake_case on disk) |
| **localStorage** | `horde.settings` — always written; authoritative for keys **not** in `SERVER_UI_KEYS` |
| **Backend-only** | Exists in server defaults / runtime; no Settings control |

See [Settings overview](index.md#three-layer-persistence) for hydration and migration.

---

## Top-level `DEFAULTS`

| Key | Default | Type | Range / notes | Storage |
|-----|---------|------|---------------|---------|
| `progress_expiry_days` | `14` | int | 1–365 | Top-level (+ mirrored as client `progressExpiryDays`) |
| `continue_watching_days` | `7` | int | Fixed | **Backend-only** — not editable in UI |
| `metadata_sync_interval_hours` | `24` | int | 1–168 | Top-level |
| `channel_catalog_enabled` | `true` | bool | YouTube channels only | Top-level |
| `channel_catalog_max_videos` | `1000` | int | 100–5000 | Top-level |
| `direct_youtube_search` | `true` | bool | Channel-page YouTube search fallback; per-channel override on `channel_catalogs.direct_youtube_search` | Top-level |
| `download_queue_paused` | `false` | bool | Restored on startup by download queue recover; set by Pause/Resume on Download | Top-level (**Backend-only** — no Settings control) |
| `ui` | `{}` | object | Deep-merged on save | UI blob container |
| `ai` | *(see below)* | object | Merged with `AI_DEFAULTS` | AI |

Related constants: catalog description limit for newest uploads ≈ 200 (`CHANNEL_CATALOG_DESC_LIMIT`).

---

## `AI_DEFAULTS`

| Key | Default | Type | Range / values | Storage |
|-----|---------|------|----------------|---------|
| `enabled` | `true` | bool | | AI |
| `provider` | `"ollama"` | string | | AI |
| `base_url` | `""` | string | Empty = discovery / default | AI |
| `embed_model` | `"nomic-embed-text"` | string | | AI |
| `chat_model` | `"llama3.2:3b"` | string | | AI |
| `openrouter_enabled` | `false` | bool | | AI |
| `openrouter_api_key` | `""` | string | Secret; not echoed after set | AI |
| `openrouter_model` | `"google/gemini-2.5-flash-lite"` | string | | AI |
| `openrouter_scope` | `"specialized"` | string | `specialized` \| `all` | AI |
| `openrouter_embed_model` | `"openai/text-embedding-3-small"` | string | | AI |
| `ollama_prefer_embeddings` | `false` | bool | | AI |
| `openrouter_show_costs` | `false` | bool | | AI |
| `openrouter_weekly_budget_usd` | `null` | float \| null | ~0.01–100000; null/0 = off | AI |
| `openrouter_budget_hard_limit` | `false` | bool | | AI |
| `schedule` | `"on_download"` | string | `on_download` \| `on_request` \| `timer` \| `set_time` | AI |
| `timer_hours` | `6` | number | Hours between timer runs | AI |
| `schedule_time` | `"03:00"` | string | Local `HH:MM` | AI |
| `last_daily_run` | `""` | string | `YYYY-MM-DD` | **Backend-only** bookkeeping |
| `auto_pull_models` | `true` | bool | | AI |
| `use_subtitles` | `true` | bool | | AI |
| `enrich_tags` | `true` | bool | | AI |
| `tag_rescan_days` | `90` | int | 7–365 | AI |
| `ai_summaries` | `true` | bool | After download when captions exist | AI |
| `ai_chat` | `true` | bool | | AI |
| `summary_length` | `"short"` | string | `short` \| `medium` \| `long` | AI |
| `ai_duplicates` | `true` | bool | On-demand Import LLM | AI |
| `category_min_score` | `0.55` | float | 0.2–0.9 | AI |
| `workload_profile` | `"normal"` | string | `light` \| `normal` \| `heavy` | AI |
| `vram_gb` | `null` | float \| null | ~0.5–256 GiB; null = autodetect | AI |
| `pending_category_refresh` | `false` | bool | | **Backend-only** flag |
| `paused` | `false` | bool | Queue pause | AI |

!!! note "Duplicate scoring"
    Duplicate LLM runs on-demand during Import when `ai_duplicates` is true. See [AI → Features](ai.md).

---

## UI blob keys (`SERVER_UI_KEYS`)

Written to localStorage always; synced to `app_settings.json` → `ui` as **snake_case**. Defaults from frontend `DEFAULTS`.

### Appearance

| Client key | Default | Type | Range / values | Storage |
|------------|---------|------|----------------|---------|
| `theme` | `"default"` | string | `default` \| `oled` \| `terminal` \| `nord` \| `light` \| `indigo` \| `cyber` \| `sunset` \| `forest` \| `slate` \| `earthy` \| `frozen` \| `mocha` \| `custom` | UI blob |
| `customColors` | `{ accent: "#22d3ee", background: "#08090c" }` | object | Hex colors | UI blob |
| `customThemes` | `[]` | array | Max **40** presets | UI blob |
| `customCss` | `""` | string | Max **64 000** chars; injected as `#horde-custom-css` when enabled | UI blob |
| `customCssEnabled` | `false` | bool | Shows the editor and injects `customCss`. Missing flag + non-empty CSS → treated as on | UI blob |
| `backgroundEffect` | `"none"` | string | See [Appearance](appearance.md#background-effects) | UI blob |
| `backgroundOpacity` | `0.45` | number | 0.1–1 | UI blob |
| `backgroundEffectSpeed` | `1` | number | 0.25–3 | UI blob |
| `backgroundEffectSize` | `1` | number | 0.5–2 | UI blob |
| `backgroundEffectColorMode` | `"accent"` | string | `accent` \| `custom` | UI blob |
| `backgroundEffectColor` | `"#22d3ee"` | string | Hex | UI blob |
| `flowingGradientPreset` | `"theme"` | string | `theme` \| `rgb` \| `cool` \| `warm` \| `mono` | UI blob |
| `customBackgroundId` | `null` | string \| null | | UI blob |
| `customBackgroundMime` | `null` | string \| null | | UI blob |
| `customBackgroundBlur` | `12` | number | 0–40 | UI blob |
| `customBackgroundTint` | `"#08090c"` | string | Hex | UI blob |
| `customBackgroundTintOpacity` | `0.45` | number | 0–1 | UI blob |
| `pauseBackgroundWhileWatching` | `false` | bool | | UI blob |
| `navIndicator` | `"liquid"` | string | `none` \| `liquid` \| `underline` \| `fade` | UI blob |
| `hoverMotion` | `"subtle"` | string | `off` \| `subtle` \| `lift` \| `glow` | UI blob |
| `translucentPanelStrength` | `0.5` | number | 0–1 (higher = more see-through) | UI blob |
| `translucentPanelBlur` | `0.5` | number | 0–1 (higher = stronger frost) | UI blob |
| `translucentPanelTintEnabled` | `false` | bool | | UI blob |
| `translucentPanelTint` | `"#ffffff"` | string | Hex | UI blob |
| `translucentPanelTintStrength` | `0.35` | number | 0–1 | UI blob |
| `translucentPanelLegibility` | `true` | bool | | UI blob |
| `loadingStyle` | `"dots"` | string | `dots` \| `spinner` \| `bar` \| `orbit` \| `pulse` \| `wave` \| `comet` \| `tiles` \| `petal` \| `blob` \| `atom` \| `cube` \| `helix` \| `spiral` \| `swarm` \| `leapfrog` \| `plus` \| `split` \| `ringwalk` \| `newton` \| `bouncebox` \| `pong` \| `goo` | UI blob |
| `fontSize` | `"medium"` | string | `small` \| `medium` \| `large` \| `xl` | UI blob |
| `uiFont` | `"default"` | string | Builtin id or saved custom id | UI blob |
| `customFonts` | `[]` | array | Saved URL/file fonts | UI blob |

### Library / downloads (UI)

| Client key | Default | Type | Values | Storage |
|------------|---------|------|--------|---------|
| `showContinueWatching` | `true` | bool | | UI blob |
| `showProgressOnContinueWatching` | `true` | bool | | UI blob |
| `showProgressOnAllVideos` | `false` | bool | | UI blob |
| `showCardDates` | `true` | bool | | UI blob |
| `defaultLibrarySort` | `"added_at"` | string | `added_at` \| `published_at` \| `title` \| `duration` \| `file_size` \| `view_count` \| `random` | UI blob |
| `channelSort` | `"recent_download"` | string | `recent_download` \| `video_count` \| `alphabetical` \| `subscriber_count` | UI blob |
| `channelOrder` | `"desc"` | string | `asc` \| `desc` | UI blob |
| `showDownloadNavBadge` | `true` | bool | | UI blob |
| `normalizeVolumeOnDownload` | `true` | bool | | UI blob |

!!! note "`progressExpiryDays`"
    Present on the client `Settings` object (default `14`) but **not** in `SERVER_UI_KEYS`. Canonical store is top-level `progress_expiry_days`.

### Playback

| Client key | Default | Type | Values | Storage |
|------------|---------|------|--------|---------|
| `showDescription` | `true` | bool | | UI blob |
| `showRelatedVideos` | `true` | bool | | UI blob |
| `autoplayRelated` | `true` | bool | | UI blob |
| `showUndownloadedOnChannel` | `true` | bool | | UI blob |
| `defaultStreamQuality` | `"auto"` | string | `auto` \| `2160` \| `1440` \| `1080` \| `720` \| `480` | UI blob |
| `subtitleSize` | `"medium"` | string | `small` \| `medium` \| `large` | UI blob |
| `subtitleLeft` | `20` | number | % from left (player drag) | UI blob |
| `subtitleOffset` | `12` | number | % from bottom (player drag) | UI blob |
| `sponsorBlockEnabled` | `true` | bool | YouTube only | UI blob |
| `sponsorBlockShowNotice` | `true` | bool | Auto-skip toast + undo | UI blob |
| `sponsorBlockSkipMode` | `"auto"` | string | `auto` \| `prompt` | UI blob |
| `sponsorBlockCategories` | see playback.md | object | Per-category booleans | UI blob |
| `defaultPlaybackRate` | `1` | number | 0.25–3 step list | UI blob |
| `playbackMode` | `"standard"` | string | Player view mode | UI blob |

### Session-ish UI state (still synced via UI blob)

These are updated from the shell/player rather than dedicated Settings rows, but they **are** in `SERVER_UI_KEYS` and therefore sync across browsers sharing the server.

| Client key | Default | Type | Values | Storage |
|------------|---------|------|--------|---------|
| `sidebarCollapsed` | `false` | bool | Library sidebar | UI blob |
| `chaptersExpanded` | `true` | bool | Watch chapters panel | UI blob |
| `descriptionExpanded` | `true` | bool | Watch description panel | UI blob |
| `aiExpanded` | `true` | bool | Watch AI panel open/closed | UI blob |

---

## Client-only (localStorage, not `SERVER_UI_KEYS`)

These live in `horde.settings` only and are **not** pushed in the `ui` blob.

| Client key | Default | Type | Notes | Storage |
|------------|---------|------|-------|---------|
| `volume` | `1` | number | Player volume 0–1 | localStorage only |
| `lastCustomChannel` | `""` | string | Last custom channel URL/handle | localStorage only |

Other localStorage keys used by Settings (not part of `DEFAULTS`):

| Key | Purpose |
|-----|---------|
| `horde.settings.tab` | Last selected settings tab |
| `horde.settings.updateDismissedSha` | Dismissed update banner SHA |

---

## Keys intentionally absent from Settings UI

| Key | Layer | Why |
|-----|-------|-----|
| `continue_watching_days` | Top-level | Fixed at 7; continue-watching row cutoff |
| `ai.last_daily_run` | AI | Set by `set_time` scheduler |
| `ai.pending_category_refresh` | AI | Internal “refresh categories after index” latch |

---

## Quick map: Settings tab → docs

| Tab | Doc |
|-----|-----|
| Overview / search / deep links | [index.md](index.md) |
| Appearance | [appearance.md](appearance.md) |
| Custom CSS | [custom-css.md](custom-css.md) |
| Library | [library.md](library.md) |
| Playback | [playback.md](playback.md) |
| AI | [ai.md](ai.md) |
| System | [system.md](system.md) |
