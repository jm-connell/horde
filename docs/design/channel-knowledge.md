# Channel knowledge (draft)

Status: **Proposed**. Nothing here is built yet. This is the plan to agree on before implementation; once settled, the decisions move into an ADR and this page becomes the design reference.

## Goal

Let a user add YouTube channels to a server-wide knowledge base ("Ask"), let Horde index every upload's captions in the background (however long that takes), and then ask questions in a chat:

- about one channel ("What does The Car Care Nut say about the 2004 4Runner?"),
- about a hand-picked set of channels,
- or about a topic, with Horde choosing the relevant channels itself,

and get an answer built only from what those channels said, with every claim linked to the video and the moment it was said. When several channels cover the topic, the answer says where they agree and where they differ ("Channel A recommends X; Channel B disagrees because Y").

Non-goals for the first version: transcribing videos that have no captions (Whisper), non-English captions, other sites than YouTube, and editing or annotating transcripts.

## What already exists and what does not fit

| Existing piece | Use | Why not as-is |
|---|---|---|
| Channel catalog (`services/channel_catalog/`) | Lists every upload of a channel (flat yt-dlp pages, up to 5,000 videos), keeps up with new uploads (feed-head sync), records members-only skips | It deletes rows beyond its cap (`_trim_beyond_cap`) and whole catalogs when it merges aliases (`reconcile_duplicate_catalogs`). Knowledge rows with a cascading foreign key to catalog rows would silently lose transcripts that took hours to fetch |
| Subtitle fetch (`downloads/subtitles.py`: `subtitle_ydl_opts`, yt-dlp `skip_download` into a temp dir) and the timedtext cooldown in `subtitle_retry.py` | Fetch one video's captions without the video; back off on 429s | Written for library videos (copies `.vtt` next to a media file). Needs a small helper that returns the VTT text instead. English only (`subtitleslangs: ["en"]`) |
| Stream caption fetch (`api/preview.py: fetch_preview_vtt`) | — | Request-bound and async in the API layer; not usable from a worker |
| `chapters.parse_vtt_cues` | `(start_sec, text)` cues | YouTube auto-captions repeat each line in the next cue ("rolling" captions); the parser only drops exact duplicates, so the chunker must remove the overlap |
| `video_embeddings` and `ai/vector_index.py` | Pattern to copy (float32 blobs, one normalised numpy matrix, exact cosine) | Hard-wired to `VideoEmbedding.video_id` with ORM listeners. Knowledge vectors are static once indexed and are always searched per channel, so a much simpler per-channel cache fits |
| `ai/chat.py: run_chat_turn` + `ChatTarget`, help chat's stateless thread and `sources` event | Streaming, model checks, auth re-checks, cost booking; client-held history | `context()` runs inside the turn, so it cannot stream progress while several retrieval/extraction calls run. Retrieval runs before the turn in a wrapper generator (as help chat already wraps the turn to emit `sources`) |
| `ai/help_model.tier()` | Guess a model's strength from its name | Use it to scale the pipeline down for small local models |
| FTS5 with triggers (ADR 0007) | Keyword index pattern | New table; the pinned-trigger test and migration docs need updating |
| Watch page | Plays library videos (`/watch/:id`) and streams (`/watch?url=`) | No start-time parameter, so citations cannot jump to a moment |

## Data model (one Alembic revision)

All in `horde.db`. Knowledge tables do not reference catalog rows with cascading keys; they copy the few fields they need.

**`kb_channels`**: one row per channel in the knowledge base.
`id`, `channel_url` (normalised, unique), `channel_name`, `catalog_id` (nullable, `ON DELETE SET NULL`, re-resolved by URL after a catalog merge), `status` (`queued` / `indexing` / `ready` / `paused` / `error`), progress counters (`video_count`, `fetched_count`, `no_captions_count`, `failed_count`, `chunk_count`), `embed_model`, `last_error`, `added_by` (user id), timestamps.

**`kb_videos`**: one row per upload of a knowledge channel.
`id`, `kb_channel_id` (FK, cascade), `yt_id`, `title`, `published_at`, `duration`, `fetch_status` (`pending` / `fetched` / `no_captions` / `members_only` / `failed`), `attempts`, `next_attempt_at`, `caption_lang`, `caption_auto`, `cues` (zlib-compressed JSON of cleaned `[start, end, text]`, kept so re-chunking never re-fetches), `cues_hash`, `embed_status`, unique `(kb_channel_id, yt_id)`.

**`kb_chunks`**: time-aligned passages.
`id`, `kb_video_id` (FK, cascade), `kb_channel_id` (denormalised for filtering), `chunk_index`, `start_sec`, `end_sec`, `text`, `model`, `dim`, `vector`.

**`kb_chunks_fts`**: FTS5 over `kb_chunks.text` (external content, rowid = `kb_chunks.id`), maintained by triggers.

Size, for a channel of 500 videos averaging 25 minutes (about 10M characters of speech): about 10k chunks; about 13 MB text, 30 MB vectors at 768 dims (half that if stored as float16), 10–15 MB FTS index, a few MB of compressed cues. Roughly **50–70 MB per channel** in the database, and in each nightly backup.

## Indexing pipeline

1. **Add a channel** (paste a channel URL or name on the Ask page, or a switch in the channel settings sheet). Horde ensures a catalog exists for it (`enqueue_channel`) and creates the `kb_channels` row.
2. **Sync the video list** from the catalog into `kb_videos` once the catalog has listed it, and again after each feed-head sync (new uploads join automatically). Shorts excluded; past live streams included. Rows the catalog trims or skips (members-only) are not deleted from the knowledge base.
3. **Fetch captions** in a new `knowledge` worker (registered in `WorkerRegistry`, skipped under `HORDE_E2E`):
   - If the video is already in the library with a caption file, read that file (no network).
   - Otherwise one subtitle-only yt-dlp call (manual English captions preferred over auto), paced like the subtitle retry worker and sharing its global timedtext cooldown so the two never hammer YouTube together.
   - Outcomes: `fetched`, `no_captions` (final), `members_only` (final), `failed` with backoff and a retry cap.
   - Pacing makes this the slow step: at about one video per 15 seconds, 500 videos take 2+ hours, longer after 429 back-offs. Channels are processed oldest-added first, newest uploads first within a channel, so answers improve while indexing runs.
4. **Chunk**: drop rolling-caption overlap, then windows of about 60–90 seconds (about 1,000–1,400 characters) with about 15–20 seconds of overlap, each with `start_sec` / `end_sec`.
5. **Embed** through the single-flight AI worker (new job kind `embed_kb_video`), with the text prefixed by `"<channel> · <title> (<upload year>)"` so short passages keep their context. Changing the embedding model re-queues embeds; cues are kept, so nothing is fetched again.

Removing a channel deletes its rows (cascade). Pause/resume stops and restarts fetching.

## Answering

Run in a wrapper generator before `run_chat_turn`, emitting `status` events ("Searching 3 channels", "Reading The Car Care Nut") and then a `sources` event, then the streamed answer.

1. **Scope**: the channels the user picked, or **Auto**: score every ready channel by keyword hits (FTS5) and by similarity of the question to the channel's chunk centroid, keep those above a threshold, at most 4 (2 for small models). The chosen channels are shown and can be changed.
2. **Query expansion** (one JSON call, skipped for small models or on failure): spelling variants and synonyms for names (auto-captions write "4Runner" as "for runner"), generations or year ranges, part names; plus a rewritten search sentence.
3. **Hybrid retrieval per channel**: FTS5 `MATCH` over the expanded terms (exhaustive: every chunk that mentions them) and vector top-k (meaning without shared words), fused with reciprocal rank fusion, grouped by video (best chunk plus number of hits), neighbouring windows merged.
4. **Context**: per video, the best 2–3 passages, labelled `[S3] <channel> · "<title>" (2021-05) @ 12:34`, sorted by date so the model can point out a changed opinion.
5. **One channel**: answer directly from the context.
6. **Several channels (viewpoints)**: per channel, one extraction call returns JSON `{covered, position, claims: [{text, sources}]}` (including "not covered", so a channel is never forced into a view); a final streamed call compares only these positions and labels agreement and disagreement. Every claim must cite sources.
7. **Citations**: the server keeps the `[S#]` → video and timestamp map, drops citations the model invented, and the client renders them as links: the library copy at that time when downloaded (`/watch/:id?t=754`), otherwise the stream view (`/watch?url=…&t=754`).

The model is told to answer only from the excerpts and to say plainly when they do not cover the question. The thread lives in the browser (`sessionStorage`), as with Ask about Horde; nothing is stored server-side, so there is no message table.

**Without a chat model** the Ask page still offers **transcript search**: keyword and semantic hits with timestamps, grouped by video.

## API (new router `api/knowledge.py`)

| Route | Who | Purpose |
|---|---|---|
| `GET /api/knowledge/channels` | `use_ai` | Channels with status and progress |
| `POST /api/knowledge/channels` | admin | Add a channel (URL or name) |
| `DELETE /api/knowledge/channels/{id}` | admin | Remove a channel and its data |
| `POST /api/knowledge/channels/{id}/pause`, `/resume`, `/reindex` | admin | Control indexing |
| `GET /api/knowledge/search` | `use_ai` | Transcript search, `{items, next_cursor}` |
| `POST /api/knowledge/chat` | `use_ai` | SSE answer: `status`, `sources`, `token`, `done`, `error` |

All with `response_model`, the error envelope, CSRF header and a classification in `tests/test_permissions.py`; `openapi.json` and `schema.d.ts` regenerated.

## Settings

Kept small. Server `ai` settings: knowledge on/off, an optional model for Ask (falls back to the chat model, like the Assistant model), maximum videos per channel (default 1,000). Fetch pacing reuses the subtitle worker's constants.

## Frontend

- **Ask page** (`/ask`, lazy-loaded, nav entry for users with `use_ai` when AI is on): channel list with progress and an "Add channel" box (admin), multi-select or Auto, chat thread with source cards (thumbnail, title, date, timestamp, play), and a Search tab for transcript search.
- **Channel settings sheet**: an "Ask" section to add or remove the channel and see its progress.
- **Settings → AI**: the knowledge switches above, and the queue breakdown counts knowledge embeds.
- **Watch**: a `t` query parameter (seconds) to start at a moment, for library videos and streams.
- Follows `DESIGN.md`; must hold up across all themes.

## Docs and housekeeping

User guide page (`docs/guides/`), this design page, an ADR (knowledge tables in SQLite, hybrid retrieval, no vector database), `docs/settings/ai.md`, `docs/features.md`, `README.md`, the help chat catalog (`help_catalog.json`), the pinned-trigger test and the migration docs (new FTS5 table and triggers).

## Tests

- Unit: rolling-caption de-duplication and chunk timing, reciprocal rank fusion, citation validation, channel routing threshold.
- `TestClient`: channel add/remove/pause permissions, search pagination, chat SSE with a stub provider (scope, sources, dropped invalid citations).
- Migration drift test and the pinned trigger set.
- Playwright: Ask page against a seeded knowledge base in `e2e/serve.py` (channel list, search, a chat turn with a stub provider, a citation link opening Watch at the timestamp).

## Phases

1. **Foundation**: tables and revision, knowledge worker (caption fetch with library reuse, chunking), embed job, FTS5, channel add/remove/progress API and UI, transcript search, Watch `t`.
2. **Ask one or more channels**: query expansion, hybrid retrieval, citations, picked channels.
3. **Auto and viewpoints**: channel routing, per-channel extraction, comparison answers.
4. **Later, if wanted**: per-video digests written once at index time (helps broad questions over many videos), a server-side saved-answers list, exports.

## Risks

- **YouTube rate limits** on caption fetches across thousands of videos. Mitigated by pacing, the shared cooldown, cookies and library reuse; a channel may still take many hours.
- **Auto-caption errors** in names. Mitigated by query expansion and keyword search over variants.
- **Small local models** (3–8B) follow the comparison format poorly. The pipeline scales down by tier; the docs recommend a larger or cloud model for Ask.
- **Database and backup growth** of about 50–70 MB per channel.
- **Privacy**: with a cloud embedding provider every caption chunk is sent to it; with a cloud chat model the excerpts are. Same rules as existing AI features; the Ask page says which provider is used.
- **Misattribution**: a model can put words in a creator's mouth. Every claim cites a timestamp, invalid citations are dropped, and source cards show the passage.

## Open questions

See the decisions list in the conversation that produced this draft; answers will be folded in here.
