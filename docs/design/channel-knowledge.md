# Channel knowledge (draft)

Status: **Proposed**. Nothing here is built yet. This is the plan to agree on before implementation; once settled, the decisions move into an ADR and this page becomes the design reference. Revised after a critical review against the code; the findings that changed the plan are listed at the end.

## Goal

Let users add YouTube channels to a server-wide knowledge base, let Horde index every upload's captions in the background (however long that takes), and then:

- **search** what was said across those channels, with links to the moment (works without AI),
- **ask** one channel, several picked channels, or **Auto** (Horde picks the relevant channels), and get an answer built only from what they said, every claim linked to a video and timestamp,
- see **viewpoints**: where channels agree and where they differ ("Channel A recommends X; Channel B disagrees because Y").

Non-goals for the first version: transcribing videos without captions (Whisper), non-English captions, sites other than YouTube, finding a channel by name (paste a channel URL or `@handle`), saving threads on the server.

## Fit with existing code

| Existing piece | Decision |
|---|---|
| Channel catalog (`services/channel_catalog/`) | **Not a dependency.** It lists only the `/videos` tab (`index.py:61`, `fetch_channel_feed` defaults to `tab="videos"`), keeps only the newest `max_videos` (100–5,000, `_trim_beyond_cap`), can be switched off (`channel_catalog_enabled`), deletes whole catalogs when it merges aliases, re-indexes every catalog daily and runs one catalog at a time. Knowledge does its own listing with the same `fetch_channel_feed` (`videos` and `streams` tabs) and only *borrows*: it seeds from an existing catalog's rows, reuses `_channel_identity_keys` / `get_catalog_by_url` logic so `@handle` and `/channel/UC…` are one channel, and listens to `after_catalog_update` to pick up new uploads early |
| Subtitle download (`downloads/subtitles.py`) | **Not reused as-is**: it needs a media file, copies `.vtt` beside it, reports every track as manual, and calls yt-dlp outside the extract gate. A new helper runs `subtitle_ydl_opts` into a temp dir **inside `call_gated(..., priority=EXTRACT_PRIORITY_BACKGROUND)`** and returns the VTT text plus whether it is auto-generated |
| Timedtext cooldown (`subtitle_retry.py`, module state) | Moves to a small **timedtext pacer on `AppContext`** with an atomic `reserve(priority)`; library caption work (download retry, metadata sync) goes first, knowledge fetches yield to it. Required by the AppContext rule once a second consumer exists |
| Caption cleanup (`chapters.parse_vtt_cues`, `_merge_rolling`, `_downsample_cues`) | Reuse: merges YouTube's rolling auto-captions into windows. End times come from the next cue's start |
| `vector_index.py` | Not reused (hard-wired to `VideoEmbedding`). A per-channel matrix cache on `ctx.caches`, size-capped (LRU), invalidated by a `(count, max id)` fingerprint because cascades and factory reset bypass ORM listeners |
| FTS5 + triggers (ADR 0007, revision 0005) | Same approach, new table. `runner._FTS_TABLE_PREFIX` becomes a tuple so the drift test and autogenerate ignore the new shadow tables; pinned trigger set updated. Knowledge requires FTS5 (all official images ship it); on a build without it the feature reports itself unavailable |
| `search_text.fts_match_expression` | Not reused: it ANDs every token. A new builder ORs quoted terms and quoted phrases ("for runner"), drops stop words, orders by `bm25()` and always has a `LIMIT`. User and model text are never FTS5 syntax |
| AI job queue (`ai/worker.py`, `ai/tasks.py`) | One new kind, **one job per channel batch** (not per video), and `_next_job` ranks library kinds ahead of knowledge kinds so new downloads' embeds, summaries and tags never wait behind a channel |
| Chat (`ai/chat.py run_chat_turn`, `ChatTarget`) | Reused for the final streamed answer. Retrieval and the extra model calls run first in a wrapper generator (a new pattern; help chat retrieves inside `context()`), which must check availability, model and `authorized()` itself and handle the budget limit (details below) |
| Assistant model (`help_model.assistant_model()`) | Ask uses it; no new model setting. `help_model.tier()` scales the pipeline down (small = 4B or less; medium = 7–30B) |
| Watch | Library videos already take a resume position (`location.state.resumeAt`); streams take none and the stream-to-library redirect drops the query. Citations always link `/watch?url=<youtube url>&t=<sec>`; Watch forwards `t` through the redirect, lets it override the saved position, and seeks in place (`horde:seek`) when that video is already playing |

## Data model (one Alembic revision)

All in `horde.db`. No foreign keys to catalog rows.

- **`kb_channels`**: `id`, `channel_url`, `channel_name`, `include_streams` (bool), `max_videos` (null = all), `status` (`queued` / `listing` / `indexing` / `ready` / `paused` / `error`), `embed_model`, `embed_dim`, `last_listed_at`, `last_error`, `added_by` (FK users, `ON DELETE SET NULL`), timestamps. Uniqueness by channel identity (the catalog's identity keys), not by URL string.
- **`kb_videos`**: `id`, `kb_channel_id` (FK, cascade), `yt_id`, `title`, `published_at`, `duration`, `is_stream`, `fetch_status` (`pending` / `fetched` / `no_captions` / `members_only` / `failed`), `attempts`, `next_attempt_at`, `caption_auto`, `cues` (zlib JSON of cleaned `[start, text]`, so re-chunking never re-fetches), unique `(kb_channel_id, yt_id)`.
- **`kb_chunks`**: `id`, `kb_video_id` (FK, cascade), `kb_channel_id` (denormalised for filtering), `chunk_index`, `start_sec`, `end_sec`, `text`.
- **`kb_chunks_fts`**: FTS5, external content on `kb_chunks.text`. Triggers use the external-content form (`INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES('delete', old.id, old.text)`), and the update trigger is `AFTER UPDATE OF text`.
- **`kb_chunk_vectors`** (phase 2): `chunk_id` (PK, FK cascade), `vector` stored as **float16** (model and dimension live on `kb_channels`). Kept apart from the text so text reads do not walk overflow pages and embed writes do not touch text rows.
- **`ai_jobs`** (phase 2): new nullable `kb_channel_id` (FK, cascade) and the new kind in the `aijobkind` enum.

Progress counts come from `COUNT` queries, not stored counters.

**Size**, for a channel of 500 videos averaging 25 minutes (about 10M characters): about 12k chunks; about 13 MB text, about 10 MB FTS index, a few MB of cues, and about 18 MB of float16 vectors at 768 dimensions. **About 45 MB per channel**, but `horde.db` is copied by 7 nightly backups and 5 pre-migration copies, so **about 0.5 GB of disk per channel** in total. Removing a channel does not shrink the file (no auto-vacuum); the docs say so.

## Indexing (phase 1: no AI needed)

1. **Add a channel** by URL or `@handle` (through `url_safety`), from the Ask page or the channel settings sheet. Options: include past live streams (default on), video limit (default all; Shorts are never listed).
2. **List** uploads with `fetch_channel_feed` for `videos` (and `streams`), paged, inside `call_gated` at background priority. Seed from an existing catalog first when there is one. Re-list daily for new uploads, plus early when `after_catalog_update` reports new rows for the same channel.
3. **Fetch captions** in a new `knowledge` worker (in `WorkerRegistry`, skipped under `HORDE_E2E`, with startup recovery like `recover_catalog_jobs`):
   - a video already in the library with a caption file is read from disk;
   - otherwise one gated subtitle-only call, after reserving the timedtext pacer at low priority; manual English captions preferred over auto;
   - outcomes `fetched`, `no_captions` and `members_only` are final; `failed` backs off and gives up after a few attempts.
   - About one video per 15 seconds: 500 videos take 2+ hours, longer after 429s. Newest uploads first, so search improves while it runs.
4. **Chunk**: merged cues into windows of about 60–90 seconds (1,000–1,400 characters) with 15–20 seconds of overlap.
5. **Remove** a channel: rows are deleted by the worker in batches (a single cascading delete over 12k chunks and FTS triggers would hold the write lock for seconds); a fetch in progress for that channel is discarded.

Factory reset erases the knowledge tables (`_ERASE_MEDIA_MODELS`) and pauses the worker.

## Transcript search (phase 1)

Keyword search over `kb_chunks_fts` within chosen channels, hits grouped by video, each with its passage, timestamp and a play link. Paginated (`{items, next_cursor}`). Needs no AI provider.

## Ask (phase 2)

Embeddings: a job per channel batch embeds about 50 videos' chunks per run, text prefixed with `"<channel> · <title> (<year>)"`. Changing the embedding model re-queues these jobs; nothing is re-fetched.

A turn, in a wrapper generator that streams `status` events ("Searching 2 channels…"), then `sources`, then the answer:

1. **Check first**: AI allowed, provider reachable, Assistant model present (otherwise an `error` event before any cost). Check `authorized()` between steps.
2. **Query expansion** (one JSON call; skipped for small models or on failure): spelling variants and synonyms ("4Runner", "4 runner", "for runner"), generation or year ranges, part names, and a rewritten search sentence.
3. **Hybrid retrieval per channel**: FTS (OR of quoted terms, `bm25`, limited) and vector top-k, fused with reciprocal rank fusion, grouped by video (best chunk plus number of hits), neighbouring windows merged.
4. **Context**: per video the best 2–3 passages, labelled `[S3] <channel> · "<title>" (2021-05) @ 12:34`, sorted by date so a changed opinion shows.
5. **Answer** with `run_chat_turn` (Assistant model, a system prompt that requires citations and says to admit when the excerpts do not cover the question).
6. **Citations**: the server keeps the `[S#]` map, drops invented ones, and sends source cards (thumbnail, title, date, timestamp, passage).

Costs: extra calls pass `usage_kind="ask"`, so they are booked; the turn's reported cost adds them to the answer's. `OpenRouterBudgetExceeded` from any step ends the turn with the usual budget error. The SSE route follows help chat (`response_class=RAW, responses=EVENT_STREAM`). The thread stays in `sessionStorage`; no message table.

## Auto and viewpoints (phase 3)

- **Auto**: rank ready channels by FTS hit count for the expanded terms plus the best similarity among each channel's top-k chunks (not a channel centroid, which blurs topics); keep those above a threshold, at most 4 (2 for small models). The chosen channels are shown and can be changed.
- **Viewpoints**: start with one call whose excerpts are grouped and labelled by channel, asked to state each channel's position (or "not covered") and where they agree or differ, every claim cited. Add a per-channel extraction step only if real questions show the single call mixing channels up.

## API (new router `api/knowledge.py`)

| Route | Who | Phase |
|---|---|---|
| `GET /api/knowledge/channels` | signed in (members see no model names or error texts) | 1 |
| `POST /api/knowledge/channels` | admin | 1 |
| `DELETE /api/knowledge/channels/{id}` | admin | 1 |
| `POST /api/knowledge/channels/{id}/pause`, `/resume` | admin | 1 |
| `GET /api/knowledge/search` | signed in | 1 |
| `POST /api/knowledge/chat` (SSE) | `use_ai` | 2 |

`response_model` everywhere except the SSE route, the error envelope, the CSRF header, classification in `tests/test_permissions.py`, regenerated `openapi.json` and `schema.d.ts`.

## Frontend

- **Ask page** (`/ask`, lazy-loaded): channel list with progress, add box (admin), Search tab (phase 1), chat with channel picker and Auto (phases 2–3), source cards with play links. Nav entry for everyone once a channel exists (and always for the admin); the chat tab needs `use_ai` and AI on. `navLinks.ts` needs a predicate beyond a single permission.
- **Channel settings sheet**: an "Ask" section (add, progress, remove).
- **Settings → AI → Jobs**: label for the new job kind (phase 2).
- **Watch**: start time as described above.
- Page-name maps: `helpPage.ts`, `customCss.ts`, the `pages` list in `help_catalog.json`. Follows `DESIGN.md` across all themes.

## Docs

User guide page, this page, an ADR (knowledge in SQLite with FTS5 and float16 vectors, own channel listing, timedtext pacer), and updates to `docs/settings/ai.md`, `docs/features.md`, `README.md`, `docs/architecture/workers.md`, `docs/architecture/ai-pipeline.md`, `docs/ops/youtube-access.md` (a new timedtext and extract consumer), `docs/design/app-context.md` (the pacer), `docs/design/sqlite-and-migrations.md` (the FTS prefix list), and the `use_ai` description.

## Tests

- Unit: caption merge and chunk timing; FTS query builder (quoting, phrases, hostile input); reciprocal rank fusion; citation validation; pacer priority.
- `TestClient`: channel add, remove and pause permissions and identity de-duplication; search pagination; chat SSE with a stubbed provider (checks before cost, sources, dropped citations, budget error); member view hides model and errors.
- Migration drift test (with the new FTS prefix), pinned trigger set, factory reset.
- Playwright: seed knowledge rows in `backend/app/e2e_seed.py`; Ask page list and search; a chat turn mocked with `page.route` (as `help-chat.spec.ts` does); a citation opening Watch at the timestamp.

## Phases

1. **Collect and search**: tables, pacer, own listing, gated caption fetch, chunking, FTS, channel management, transcript search, Watch start time. No AI involved.
2. **Ask**: embeddings (batched job, scheduler priority), query expansion, hybrid retrieval, citations, cost and budget handling.
3. **Auto and viewpoints.**
4. **Later, if wanted**: finding channels by name, per-video digests for broad questions, saved threads, the user's own library as a source.

## Risks

- **YouTube rate limits** across thousands of caption fetches: pacing, priority below library work, the extract gate and cookies; a big channel may take many hours or a day.
- **Auto-caption errors in names**: query expansion and keyword search over variants.
- **Small local models** follow citation and comparison instructions poorly: the pipeline scales down, and the docs recommend a larger or cloud Assistant model for Ask.
- **Disk**: about 0.5 GB per channel including backups.
- **Privacy**: a cloud embedding provider receives every chunk; a cloud chat model receives the excerpts. The Ask page names the provider through `help_model.provider_label`.
- **Misattribution**: every claim cites a timestamp, invented citations are dropped, source cards show the passage.

## Review findings that changed this plan

Own channel listing instead of the catalog (Shorts already absent, streams never listed, cap and merges); a gated caption helper instead of `download_subtitles`; the pacer on `AppContext` with library priority instead of sharing the module cooldown; external-content FTS triggers and the drift-test prefix; vectors in their own float16 table; batched embed jobs with priority over FIFO; checks, budget and cost handling before extra model calls; members' reduced AI view; a new FTS query builder; the real backup footprint; Watch start time via the stream URL; keyword search and channel management needing no AI, so phase 1 ships without embeddings; one-call viewpoints first.
