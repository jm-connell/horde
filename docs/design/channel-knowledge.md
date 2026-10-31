# Channel knowledge (Ask)

Status: **Built** ([ADR 0022](../adr/0022-ask-channel-knowledge.md)). User guide: [Ask](../guides/ask.md).

Ask indexes what YouTube channels say in their videos (captions only), lets anyone search it, and answers questions about it in the chat panel with a numbered reference to the moment for every point. Code: `backend/app/services/knowledge/`, `backend/app/api/ask.py`, `frontend/src/pages/Ask.tsx`, `frontend/src/pages/ask/`, the chat panel (`components/HelpChatPanel.tsx`).

## Data (revision `0022_ask_knowledge`)

| Table | What it holds |
|---|---|
| `kb_channels` | One per Ask channel: canonical URL (unique), name, `include_streams` (default off), `max_videos` (null = all), `status` (`queued` / `listing` / `indexing` / `ready` / `paused` / `error`), the embedding model and dimension of its vectors, `added_by` (`SET NULL`) |
| `kb_videos` | One per upload: YouTube id, title, description, date, `is_stream`, `position` (0 = newest), `fetch_status` (`pending` / `fetched` / `no_captions` / `members_only` / `failed`), attempts and next attempt, `caption_auto`, `cues` (zlib JSON of `[start_sec, text]` lines of about 5 seconds), `embedded_model` |
| `kb_chunks` | Passages: `start_sec`, `end_sec`, `text`; `chunk_index` -1 is the title and description. `kb_channel_id` is denormalised for filtering |
| `kb_chunks_fts` | FTS5, external content on `kb_chunks.text`; triggers `trg_kb_chunks_fts_insert` / `_update` (`AFTER UPDATE OF text`) / `_delete` use the external-content `'delete'` form |
| `kb_chunk_vectors` | `chunk_id` → float16 vector |
| `ask_threads`, `ask_messages` | Each user's saved chat (Ask channels and Ask about Horde), with each answer's references or doc sources as JSON |

`ai_jobs.kb_channel_id` serves the `embed_kb_channel` job. Nothing references the channel catalog: it trims beyond its cap, merges duplicates by deleting rows, and can be switched off. Progress counts are `COUNT` queries, never stored. Factory reset (erase media) deletes these tables.

## Indexing

The `ask` worker (`knowledge/worker.py`, in the `WorkerRegistry`, off under `HORDE_E2E`) does one unit of work per pass:

1. **List** a channel that is new, failed listing an hour ago, or was listed a day ago: `fetch_channel_feed` for the Videos tab (and Live when `include_streams`), 100 per page, inside `call_gated` at background priority (`knowledge/listing.py`). Shorts are never listed; upcoming and live broadcasts are skipped. Rows that disappear from a listing are kept.
2. **Fetch** one video's captions, oldest-added channel first, newest upload first (`knowledge/captions.py`): from the library copy's caption file when there is one, otherwise a subtitle-only yt-dlp call in the extract gate. The call also returns the description. A YouTube fetch runs only when no library caption retry is due and `TimedtextPacer.try_reserve_background(15)` succeeds; a rate limit (`RETRY`) backs the video off and blocks every caption fetch (`services/timedtext.py`). Other failures retry three times, an hour apart and growing.
3. **Chunk** (`knowledge/chunking.py`): `chapters.caption_lines` merges YouTube's rolling captions into 5-second lines that hold each word once; passages gather lines up to 75 seconds or 1,400 characters and start the next 15 seconds before the end.
4. **Embed** (`knowledge/embed.py`): after fetches and on idle passes, an `embed_kb_channel` job is queued for any channel with passages not embedded with the current model. A job embeds 25 videos (text prefixed with channel, title and year), commits before each provider call, and queues the next batch. `ai/worker._next_job` picks library jobs first. Only videos embedded with the channel's model are searched, so changing the model re-embeds without mixing vector spaces.

Removing a channel deletes its passages in batches of 500 (the FTS triggers fire per row) before the channel; turning streams off deletes stream videos 50 at a time. The worker re-reads rows after every network call, so a channel removed or paused meanwhile is skipped. A listing cut off by a restart starts over (`worker.recover`).

## Search

`knowledge/search.py` builds every MATCH expression itself: each term is a quoted phrase (a lone word of four letters or more also matches its endings), stop words are dropped, terms are ORed and ranked by `bm25`, always with a `LIMIT`. Hostile input never reaches FTS5 syntax. `GET /api/ask/search` links each hit to the caption line within the passage that shares the most words with the query (`knowledge/moments.py`), two seconds early.

## Chat

`POST /api/ask/chat` (`knowledge/ask_chat.py`) streams one turn:

1. **Source** (`knowledge/routing.py`): "all my channels" → every channel with passages; channels the question names (name or handle, with or without "the", spaces or an `'s`) → those; else the `channel_ids` the client sends (the channel page it was opened on, or the previous answer's channels) → those; else Ask about Horde. Events `thread` and `scope` say which.
2. **Ask about Horde** runs `help_chat.stream_help_events` with the saved history and a store that writes both turns to the thread.
3. **Channels**: check the AI is allowed and the Assistant model present before any cost; keep the channels with the most matching passages when there are more than the model compares (two for small, four otherwise); expand the question with one JSON call (spellings captions use, generations, part names; skipped for small models); for each channel fuse keyword and vector rankings (reciprocal rank fusion, k = 60) and pick the best videos' best non-overlapping passages within a fair share of the budget (6,000 / 12,000 / 20,000 characters by model tier); number the excerpts in date order, without times. Nothing found → a fixed answer, no model call.
4. The model (`SYSTEM_PROMPT`) cites `[n]` only and never writes times; several channels → where they agree and disagree; changed views → with years. Its answer is resolved before it is saved (`knowledge/references.py`): numbers it was not given are dropped, the rest renumbered in order of first use, each resolved to the caption line its sentence matches (an excerpt cited for two different moments becomes two references). A `references` event precedes `done`; the expansion call's cost is added to the turn's.

The panel hides the model's raw numbers while streaming and renders the final markers as superscript links (`AiMarkdown`'s `cite` hook) with a reference list (channel, title, year, timestamp, the caption line). Links open `/watch/<id>?t=` for a downloaded copy, else `/watch?url=…&t=`; the watch page reads `t`, keeps it through the stream-to-library redirect and seeks in place when that video is open.

## Permissions

`manage_ask` (off by default) adds, changes, pauses, resumes and removes channels; everyone signed in lists channels and searches; `use_ai` chats and reads, lists and deletes their own threads. Members see a generic error instead of YouTube's text.

## Sizes and limits

A 500-video channel of 25-minute videos is about 12,000 passages and about 45 MB (13 MB text, 10 MB FTS, 18 MB float16 vectors at 768 dimensions, a few MB of lines), copied by 7 nightly and 5 pre-migration backups. The vector cache keeps 8 channels. English captions only; videos without captions are listed but only their title and description are searchable.
