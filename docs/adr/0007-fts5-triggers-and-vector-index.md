# 0007. FTS5 maintained by triggers, and the vector index cache

Status: Accepted

## Context

Search and tag queries scanned the whole `videos` table: tags were matched with `LIKE '%"tag"%'` over a JSON column, keyword search ran a REGEXP over several text columns in SQLite, and YouTube-id lookups parsed every URL in Python. Similarity search unpacked and multiplied every stored embedding blob in Python on each query. Both are fine at a few hundred videos and slow at tens of thousands of videos and tens of thousands of chunks, on a NAS CPU.

The application writes `videos.tags` and the `video_ai_meta` tag lists from many places (edits, AI enrichment, downloads, bulk operations). A derived index maintained by the application would be wrong the first time one writer forgot it.

## Decision

**Derive in the database, with triggers.** Revision `0005_tags_search` adds:

- `video_tags(video_id, tag, source)` (`ON DELETE CASCADE`, case-insensitive `tag` with an index). `videos.tags` stays the column the application writes (it keeps order and spelling and is what the API returns); triggers rebuild a video's rows whenever `videos.tags`, or `ai_tags` / `user_tags` in `video_ai_meta`, change. `source` is `user`, `ai` or `source`. Nothing in the application writes this table. Tag filters, tag listings and related-video overlap read it.
- `videos_fts`, an FTS5 table over title, description, notes, channel and tags (rowid = `videos.id`), also trigger-maintained. Query words are runs of Unicode letters and digits, folded for diacritics, and each token (with light inflections) is sent as a quoted term joined by `AND`, so user input is never FTS5 syntax. A query with no word characters, or a SQLite built without FTS5 (the revision then skips the index with a warning), falls back to the escaped REGEXP scan.
- `videos.youtube_id`, indexed and derived from `source_url` or the `[id]` token in the file name by a mapper listener on insert and update.

Triggers are invisible to autogenerate, so the drift test ignores the FTS shadow tables and a test pins the exact set of triggers.

**A vector index cache, not a vector database.** `services/ai/vector_index.py` holds the embeddings as one L2-normalised `float32` matrix per dimension and scores a query with a single matrix-vector product (exact cosine search, `numpy`). It lives on the engine object, not in module state. It is built on first use and then **updated incrementally**: each search asks the database, on a fresh connection, for `(video_id, chunk count, max id)` per video (an index-only scan), re-reads only videos whose fingerprint changed or that the ORM reported as written, masks old rows and appends new ones, compacts when more than a fifth of rows are dead, and rebuilds fully only when more than 20 percent of the videos (and more than 50) changed at once. This covers bulk Core deletes and cascades. One lock serialises refreshes and searches so concurrent searchers wait for one refresh instead of each building a copy.

## Consequences

- Reads no longer scale with table size for tags, keyword search and id lookup; a benchmark script (`backend/scripts/bench_library.py`) measures before and after.
- A writer cannot forget to keep tags or FTS in step, including raw SQL and migrations. The cost is write amplification (a tag edit rewrites that video's tag rows) and hidden behaviour, hence the pinned trigger test.
- **Revisions that rebuild `videos` or `video_ai_meta` with `batch_alter_table` drop the triggers** and must recreate them and refill `videos_fts`. This is the main trap; the revision and the migration docs say so.
- Restoring a database made with FTS5 onto a SQLite without FTS5 breaks every write to `videos`. All official images ship FTS5.
- Memory for vectors is about `chunks x dim x 4` bytes (60 000 chunks of 768 dimensions is about 184 MB, plus up to 25 percent headroom). `numpy` becomes a dependency. Vectors of another dimension (an old embed model) are ignored until re-indexed.
- Search is exact, so results do not change with index state; there is no approximate index to tune or to go stale. If libraries grow far beyond this, an ANN index can replace the matrix behind the same `top_chunks` function.

Detail: [SQLite and migrations](../design/sqlite-and-migrations.md), [AI pipeline](../architecture/ai-pipeline.md).
