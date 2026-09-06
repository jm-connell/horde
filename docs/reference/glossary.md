# Glossary

Short definitions for terms used across the Horde UI and wiki.

## Catalog

A channel’s **remote listing** of videos (metadata from YouTube / yt-dlp) used to browse what exists upstream, mark downloads, and drive channel feeds. Distinct from the local **library** of files on disk. Catalog sync can run in phases and stores progress on `channel_catalogs` rows.

## Embedding

A numeric vector representing text (title, description, notes, tags, subtitle chunks) for **semantic search**, related videos, and recommendation shelves. Usually produced by a local Ollama embed model; optionally by OpenRouter when scope is `all`. See [Local vs cloud AI](../design/local-vs-cloud-ai.md).

## GPU

Settings → System → Resources **GPU** is the card visible to the **`horde` container** (not Ollama). **None detected** is normal with stock compose. Horde does not need a GPU to download, browse, or play the library. See [GPU](../ops/environment.md#gpu).

## POT

**Proof of Origin Token** support for YouTube access via yt-dlp’s bgutil HTTP provider. When `YTDLP_POT_BASE_URL` points at a running [bgutil](#bgutil) POT server, Horde configures yt-dlp to use it, which can reduce bot-check failures. Health exposes POT provider status, cookie readiness, and the last classified extract failure.

## error_kind

Typed download / preview failure class stored on `download_jobs` and SSE progress (`bot`, `pot`, `cookies`, `members`, `rate_limit`, `unavailable`, `postprocess`, `cancelled`, `unknown`). The Download UI uses it for labels and fix hints. See [Troubleshooting](../ops/troubleshooting.md#download-error_kind-values).

## Review

A library row with `needs_review=True`: ingested media that still needs human placement (especially a **channel**) before it is treated as a normal catalogued item. See [Review queue](../design/review-queue.md).

## Workload profile

**Light / Normal / Heavy** intensity for Ollama-side AI work. Combined with a VRAM tier to pick models and invent/index limits. Critical VRAM locks to Light only. See [Workload profiles](../design/workload-profiles.md).

## OpenRouter scope

| Value | Meaning |
|-------|---------|
| `specialized` | Cloud LLM for summaries/chat/tags/duplicates; embeddings prefer local |
| `all` | Cloud may also handle embeddings / invent vectors |

Configured under AI settings. See [Local vs cloud AI](../design/local-vs-cloud-ai.md).

## Sprite

A **seek-preview sprite sheet**: a grid of frame thumbnails (plus JSON meta) generated for a library video so scrubbing the timeline can show a picture-in-picture style preview. Stored beside the media workflow; `sprite_path` / `has_sprites` expose status to the player.

## Chunk

A slice of subtitle (or related) text indexed for embeddings. `chunk_index` of `-1` means the metadata document; `0+` indexes subtitle chunks so long videos remain searchable by spoken content without one giant vector.

## Loudnorm

ffmpeg **loudness normalization** (`loudnorm` filter) optionally applied after download so archived files have more consistent volume than raw YouTube encodes. Toggle via download / settings (`normalize_volume` / normalize on download). YouTube’s own playback loudness is not preserved in the file by default.

## bgutil

Companion **POT provider** (bgutil HTTP) used with yt-dlp for YouTube. Horde does not bundle it; you run it separately and set `YTDLP_POT_BASE_URL`. See [YouTube access](../ops/youtube-access.md).

## Continue watching

Home-row (and related UI) of videos with saved playback position that are not finished. Progress lives on the video row (`last_position_sec`, `last_watched_at`); dismissals can be local. Toggle visibility in Settings.

## Hybrid search

Library search that combines **keyword** matching with optional **semantic** ranking over embeddings (when AI/embeddings are available). Lets you find videos by phrasing that never appears verbatim in the title. See [Search](../guides/search.md).

## Related terms

- [Channel / year layout](../design/channel-year-layout.md) — on-disk path shape
- [FAQ](faq.md) — common questions
- [AI features](../guides/ai-features.md) — end-user AI behavior
