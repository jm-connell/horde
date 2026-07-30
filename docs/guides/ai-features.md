# AI features

Optional AI turns Horde from a downloader into a smarter archive: semantic search, related videos, summaries, chat, tags, recommendation shelves, and duplicate help.

## Prerequisites

AI features need **providers ready**:

- **Embeddings** — Ollama and/or OpenRouter (for search indexes, related, catalog embeds, categories)
- **Chat / LLM** — Ollama and/or OpenRouter (summaries, chat, enrich tags, category invention, duplicate confirmation)

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
| **Chat** | Ask questions about a video (metadata + optional subs) | Chat LLM |
| **Enrich tags** | Suggest / apply topical tags | Chat LLM |
| **Recommended tab** | Home **Library / Recommended** tabs with category shelves | Embed + categories ready |
| **Duplicate confirmation** | Score heuristic duplicate groups on Import | Chat (+ optional embed similarity) |

## Summaries

From a video’s AI panel, generate a short/medium/long summary (length is a setting). Summaries use title, description, and optionally subtitle text depending on configuration.

## Chat

Per-video chat lets you ask about content, chapters, or themes. Context is built from metadata and captions when available. Requires a working chat provider.

## Enrich tags

**Enrich tags** proposes tags from content signals. Existing tags are respected (avoid near-duplicates). Tags then appear as library chips when counts exceed the display threshold ([Library](library.md)).

## Recommended tab

When AI is ready, the library home shows:

- **Library** — normal grid
- **Recommended** — category shelves filled by embedding similarity to category centroids / seeds

Categories are invented/maintained by the AI pipeline; match strictness is tunable (`category_min_score` and related settings). Opening Recommended without providers simply won’t appear or will show empty/loading states until indexes exist.

## Duplicate confirmation

On [Import & review](import-review.md), possible duplicate groups can be scored with AI when **AI duplicate confirmation** is enabled. Scoring is **on-demand** from the Import API (not a background AI job). Use **Keep this**, **Delete**, or **Not a duplicate** to resolve groups.

## Search indexes & catalog embeds

- Library videos get `embed_video` jobs for semantic search and related
- Channel catalog entries can get `embed_catalog_video` after [catalog phases](channels.md) reach **embed**
- Changing the embedding model prompts a rebuild so shelves and search stay coherent

## Single-flight & queues

AI work is queued and rate-limited (single-flight patterns, workload profiles). Watch [Settings → AI](../settings/ai.md) queue status for embed / catalog / enrich breakdowns. See [Single-flight AI](../design/single-flight-ai.md) and [AI pipeline](../architecture/ai-pipeline.md).

## Related

- [Search](search.md) — hybrid search and subtitle indexing
- [Library](library.md) — Recommended tab
- [Import & review](import-review.md) — duplicates
- [AI settings](../settings/ai.md)
- [AI setup](../ops/ai-setup.md)
- [AI pipeline](../architecture/ai-pipeline.md)
