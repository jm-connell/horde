# 0022. Ask: channels' captions as a knowledge base in SQLite, cited to the moment

Status: Accepted

## Context

Some channels publish long, detailed videos that are hard to search: what a channel said about a car, a part or a product is spread over dozens of hours. Horde already embeds the captions of downloaded videos for search, but drops their timestamps, only covers downloaded videos, and chats about one video at a time. The channel catalog lists a channel's uploads but only from the Videos tab, keeps at most its cap, merges duplicate catalogs by deleting rows, and can be switched off. YouTube rate-limits caption requests (timedtext) and Horde's library caption retries already back off around those limits.

## Decision

- **Store in SQLite, no vector database.** `kb_channels`, `kb_videos` (with each video's cleaned caption lines, compressed, so re-chunking never fetches again), `kb_chunks` (passages of about 75 seconds overlapping by 15, plus one for the title and description), an external-content FTS5 index kept by triggers, and `kb_chunk_vectors` (float16, apart from the text). Semantic search is an exact numpy product over a per-channel matrix held on the `AppContext`, as for library search (ADR 0007). Nothing cascades from the catalog.
- **Own listing and a shared pacer.** Ask lists channels itself (`videos` and, when asked, `streams` tabs) and fetches captions with a subtitle-only yt-dlp call inside the extract gate at background priority. A `TimedtextPacer` on the `AppContext` replaces the module-level cooldown: library caption work uses its block; Ask uses a separate spaced slot that never sets the block, and waits whenever a library retry is due. A 429 Ask hits blocks everyone.
- **Embeddings behind library work.** One AI job per channel batch (`embed_kb_channel`), and the AI worker picks library jobs first.
- **Hybrid retrieval with one model call for spellings.** The chat model expands the question into the spellings captions produce and related terms (skipped for small models); each channel is searched by keyword and by meaning, merged by reciprocal rank fusion, and given a fair share of the excerpt budget.
- **Citations resolved by the server.** The model sees numbered excerpts without times and must cite numbers. The server drops numbers it did not give, renumbers in order of use, and resolves each to the caption line its sentence matches, linking two seconds early. Answers are saved with their references.
- **One chat, routed by naming a channel.** The Ask about Horde panel answers from channels when the question names one (or the client says which: opened on a channel page, or the previous answer's channels), and is Ask about Horde otherwise. Conversations of both kinds are saved per user (`ask_threads`, `ask_messages`). No per-video AI summaries: titles and descriptions serve as the video-level signal.

## Consequences

- A channel takes hours to index (about one video per 15 seconds) and about 45 MB of database, multiplied by the backups.
- Search and indexing work without an AI provider; asking needs a chat model; meaning-based search needs an embedding model.
- A reference can be a few seconds off when a point is spread across lines, and auto-captions misspell names; references show the caption line so a reader can check.
- `/api/ai/help/chat` (the client keeps the thread) still exists; the app uses `/api/ask/chat`.
- A SQLite build without FTS5 cannot use Ask (official images have it).

Detail: [Channel knowledge](../design/channel-knowledge.md), [Ask](../guides/ask.md).
