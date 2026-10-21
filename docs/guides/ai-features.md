# AI features

Optional AI turns Horde from a downloader into a smarter archive: semantic search, related videos, summaries, chapters, chat, tags, recommendation shelves, and duplicate help.

## Prerequisites

AI features need **providers ready**:

- **Embeddings** — Ollama and/or OpenRouter (for search indexes, related, catalog embeds, categories)
- **Chat / LLM** — Ollama and/or OpenRouter (summaries, chapters, chat, enrich tags, category invention, duplicate confirmation)

Configure under [Settings → AI](../settings/ai.md) and follow [AI setup](../ops/ai-setup.md). Until embed/chat models are present and healthy, Library stays on a single home tab (no Recommended), hybrid search degrades to keyword-only, and LLM actions stay unavailable.

!!! tip "Workload profiles"
    Use workload profiles so indexing and chat don’t thrash a small GPU. See [Workload profiles](../design/workload-profiles.md) and [Local vs cloud AI](../design/local-vs-cloud-ai.md).

## Feature overview

| Feature | What it does | Needs |
|---------|----------------|--------|
| **Hybrid search** | Keyword + embedding ranking; no UI semantic toggle | Embed indexes |
| **Use subtitles in search indexes** | Include VTT/caption text in corpora (`use_subtitles`) | Embed rebuild after change |
| **Related videos** | Neighbors on the watch page | Embeddings |
| **Summaries** | Generate a synopsis for a video | Chat LLM |
| **Chapters** | Generate Watch markers from captions when the description has none | Chat LLM |
| **Chat** | Ask questions about a video (metadata + optional subs) | Chat LLM |
| **Enrich tags** | Suggest / apply topical tags | Chat LLM |
| **Recommended tab** | Home **Library / Recommended** tabs with category shelves | Embed + categories ready |
| **Duplicate confirmation** | Score heuristic duplicate groups on Import | Chat (+ optional embed similarity) |

## Summaries

When **AI video summaries** is on, a summary is queued after download once captions are on disk. Length is a setting (`short` / `medium` / `long`). Watch still has **Regenerate**, and older videos without a summary can **Generate** from the AI panel. Summaries use title, description, and caption text.

## Chapters

When **AI video chapters** is on, choose **On download** or **Watch page**. On download queues a chapter job after captions exist if the description (and yt-dlp chapter list) do not already provide markers. Watch page only generates when you click the button on a video. Videos under 3 minutes and lyric-heavy captions are skipped automatically; Watch **Generate** still runs for those. After AI markers exist, Watch shows a short “AI generated chapters” note and **Regenerate** on the Description row. Markers are stored beside the video; the description is not rewritten. Description timestamps always win over yt-dlp and AI.

## Chat

Per-video chat lets you ask about content, chapters, or themes. Context is built from metadata and captions when available. Requires a working chat provider. The watch-page AI panel always opens on **Summary**; switching to Chat is not remembered across videos or reloads.

## Streamed videos

A video you stream without downloading (`/watch?url=…`) gets the same AI panel: **Summary**, **Chat** and **Generate** chapters work from its title, description and English captions (fetched from the stream the first time you use AI on it; a stream without captions can still be chatted about from its metadata). Only YouTube videos are supported.

Results are saved per video. Opening the stream again shows them without spending tokens, and **downloading the video moves them onto the library copy** (its own summary or chapters win if it already has some; your chat joins your conversation about the video, in time order). If nobody opens the stream for `HORDE_STREAM_AI_RETENTION_DAYS` (default **30**) days and it was not downloaded, its saved results are deleted. The AI panel shows the date they are kept until. See [ADR 0010](../adr/0010-stream-ai-retention.md).

## Enrich tags

**Enrich tags** proposes tags from **title, channel, and description** (subtitle excerpt is optional when captions exist). Existing tags are respected (avoid near-duplicates), and the model is shown the library's most used tags so it reuses their exact spelling instead of inventing synonyms. Tags then appear as library chips when counts exceed the display threshold ([Library](library.md)).

Summaries still require downloaded captions; tag enrichment does not.

## Recommended tab

When AI is ready, the library home shows:

- **Library** — normal grid
- **Recommended** — "For you", ranked from your own watch history, plus category shelves

**For you** favours what you watched recently and watched through, leaves out what you have already seen (it moves to the end), boosts channels you follow, and mixes channels instead of filling the row from one.

**Categories** are invented by the chat model from a sample of the library, with the sample videos that belong to each, and refreshed with **Refresh categories**. A video is shown only under the categories it fits best, so a shelf does not fill up with videos that belong to another one. Match strictness is tunable (`category_min_score`). How the scores work: [AI pipeline](../architecture/ai-pipeline.md#recommendations). Opening Recommended without providers simply won’t appear or will show empty/loading states until indexes exist.

## Duplicate confirmation

On [Import & review](import-review.md), possible duplicate groups can be scored with AI when **AI duplicate confirmation** is enabled. Scoring is **on-demand** from the Import API (not a background AI job). Groups show verdict, confidence, optional similarity score, and reason text; if AI is enabled but no chat provider is up, the UI shows **AI unavailable** (`ai_error`) instead of a silent blank. Use **Keep this**, **Delete**, or **Not a duplicate** to resolve groups.

## Search indexes & catalog embeds

- Library videos get `embed_video` jobs for semantic search and related
- Channel catalog entries can get `embed_catalog_video` after [catalog phases](channels.md) reach **embed**
- Changing the embedding model prompts a rebuild so shelves and search stay coherent
- Failed indexes store `embed_status=error` + `embed_error` on the video; rebuild from Jobs

## Single-flight & queues

AI work is queued and rate-limited (single-flight patterns, workload profiles). Watch [Settings → AI → Jobs](../settings/ai.md) for:

- **Runnable / deferred / waiting / failed** counts (not one opaque “N queued”)
- **Blocked** state when jobs sit waiting on Ollama/OpenRouter
- **Failed jobs** list with Retry / Retry all / Clear failed

See [Single-flight AI](../design/single-flight-ai.md) and [AI pipeline](../architecture/ai-pipeline.md).

## Related

- [Search](search.md) — hybrid search and subtitle indexing
- [Library](library.md) — Recommended tab
- [Import & review](import-review.md) — duplicates
- [AI settings](../settings/ai.md)
- [AI setup](../ops/ai-setup.md)
- [AI pipeline](../architecture/ai-pipeline.md)
