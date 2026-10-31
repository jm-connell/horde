# AI features

Optional AI turns Horde from a downloader into a smarter archive: semantic search, related videos, summaries, chapters, chat, tags, recommendation shelves, and duplicate help.

## Prerequisites

AI features need **providers ready**:

- **Embeddings** — the provider's embedding model, or a second server's (for search indexes, related, catalog embeds, categories)
- **Chat / LLM** — the provider's chat model (summaries, chapters, chat, enrich tags, category invention, duplicate confirmation)

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
| **Ask about Horde** | Answers how-to questions from the docs and source, links to and changes settings, answers about your own library, queues downloads, builds playlists and writes custom CSS | Chat LLM (or the Assistant model) |
| **Enrich tags** | Suggest / apply topical tags | Chat LLM |
| **Recommended tab** | Better "For you" ranking (by content) and category shelves | Embed + categories ready |
| **Duplicate confirmation** | Score heuristic duplicate groups on Import | Chat (+ optional embed similarity) |

## Summaries

When **AI video summaries** is on, a summary is queued after download once captions are on disk. Length is a setting (`short` / `medium` / `long`). Watch still has **Regenerate**, and older videos without a summary can **Generate** from the AI panel. Summaries use title, description, and caption text.

## Chapters

When **AI video chapters** is on, choose **On download** or **Watch page**. On download queues a chapter job after captions exist if the description (and yt-dlp chapter list) do not already provide markers. Watch page only generates when you click the button on a video. Videos under 3 minutes and lyric-heavy captions are skipped automatically; Watch **Generate** still runs for those. After AI markers exist, Watch shows a short “AI generated chapters” note and **Regenerate** on the Description row. Markers are stored beside the video; the description is not rewritten. Description timestamps always win over yt-dlp and AI.

## Chat

Per-video chat lets you ask about content, chapters, or themes. Context is built from metadata and captions when available. Requires a working chat provider. The watch-page AI panel always opens on **Summary**; switching to Chat is not remembered across videos or reloads.

## Ask about Horde

The footer at the bottom of every page has an **Ask about Horde** button. It opens a chat panel in the corner of the screen: ask how to set up AI, why a download failed, where files live or how a feature works under the hood. The panel is not in the way of the app: it stays open, with the same conversation, as you move between pages, and you can drag it by its header and resize it from its top-left corner (on a phone it fills the bottom of the screen, and following a link in an answer closes it). In the installed app on a phone, the **Chat** tab of the tab bar opens and closes it, and it sits just above the bar. **Escape** or the close button hides it; **Clear** starts over.

Each question also tells Horde which page you are on (for example "Settings, Playback tab" or the video playing), so "what does this page do?" gets a useful answer.

Answers come from the documentation and the source code shipped with your version of Horde: the wiki pages, `README.md`, `.env.example`, `docker-compose.yml`, the changelog, and the backend and frontend code. For each question Horde picks the best-matching sections (a keyword search, no embeddings needed) and sends them with the features overview to the chat model, so it works with small local models too. Under each answer, **Sources** links the wiki pages and the files on GitHub (at your build's commit) it was given.

- Needs the `use_ai` permission and a working chat provider; it does not depend on the **AI video chat** toggle. With OpenRouter, spend is recorded under `chat` in the cost ledger.
- Members are told when something is an administrator's setting.
- The conversation, and where you put the panel, are kept in the browser tab only (until the tab closes or **Clear**); the server stores none of it. Each question sends the last few turns back, with roughly 6,000 tokens of excerpts, so a local model needs a context window of at least 8K tokens (Ollama: `OLLAMA_CONTEXT_LENGTH=8192` or more) for good answers.
- Answers can be wrong. The model only sees the excerpts it was given; check the linked pages before changing anything important.

When the panel opens it suggests five questions, a different mix each time; the first is always **What can you do?**, which lists everything below (answered by the app itself, without asking the model).

### Links to settings and pages

When an answer mentions a setting or a page it links it. Following a setting link opens the right Settings tab (or the Account page), scrolls to the setting and rings it in the accent color for a moment. The panel stays open (on a phone it closes, so you can see the page). You can make the same links yourself: `/settings?tab=appearance&find=background` jumps to the Background section; a `find` that is no section's name searches Settings for those words instead.

### Changing settings for you

Ask for a change ("make the text bigger", "turn on SponsorBlock") and the answer comes with a card: **Change Text size to Large** and an **Apply** button, then **Undo**. Nothing changes until you press it. The assistant may change your own appearance, library and playback preferences, and (for the administrator) a few server switches such as YouTube search, Recommended+ and the video chat; those cards say they change it for everyone. For anything riskier, such as AI providers and keys, models, budgets, the AI features that run on every download (summaries, chapters, tags), two-step sign-in, the storage limit, the download format or a reset, it only links to the setting. The full list, and which are which, is `backend/app/services/ai/help_catalog.json`.

### Your own data

Turn on **Use my data** (Settings → Library) and the assistant can answer about your downloads ("why did my last download fail?"), watch history ("what did I watch this week?"), playlists and library ("which channels take the most space?", "find that cooking video", "what should I watch next?"). Only a question about your own things gets any ("my downloads", "did I watch…", "what should I watch next", "make a playlist of…"); how-to questions send none, even "how do I change my password?". Then only what it needs is sent, as a few short lines: the words of the question pick which (failed downloads, recent history, your playlists and what is in them, library totals, a library search or unwatched videos). If it does not find what you mean, say "my downloads" or "my library". Everything is read as you see it: your own history, playlists you can open, downloads you may see.

It has three choices: **Off**, **AI on my network only** and **Any AI, including cloud**; under them Settings says which AI you have and whether your data goes to it. A cloud provider such as OpenRouter, or an Ollama cloud model (one whose name ends in `cloud`, such as `gpt-oss:120b-cloud`, which your Ollama server passes on to ollama.com), only gets your data with **Any AI, including cloud**: with **AI on my network only** the server holds it back, even if the AI changes to a cloud one later. The choice is saved per account, and the assistant links the setting when a question needs your data and it is off. Questions about custom CSS also send your saved stylesheet when they mention CSS.

### Downloads and playlists

Give the assistant a link and it offers a **Download** card with a quality picker; ask for a playlist of videos it found and it offers **Make playlist** (or **Add** to one of your playlists). Each needs your click, and goes through the same permission checks as the Download and Playlists pages.

### Custom CSS

Describe a change to how Horde looks ("rounder video cards", "a frosted top bar") and the assistant writes the CSS with a **Preview** button. The preview is on the page for 20 seconds with a bar at the top: **Keep** adds it to your [custom CSS](../settings/custom-css.md) (and turns custom CSS on; **Undo** takes it back), **Revert** or **Escape** removes it, and if you do nothing it reverts by itself, so CSS that hides the page (even the bar) cannot lock you out. Only one preview runs at a time. If a saved stylesheet ever does, open Horde in a browser tab with `?nocss` on the address (for example `http://horde:8080/?nocss`): custom CSS stays off in that tab until you turn it back on.

### Which model it uses

The assistant uses the chat model unless the administrator sets an **Assistant model** under [Settings → AI → Models](../settings/ai.md#models), which lets it use a stronger model without making summaries and tags cost more. It knows roughly how capable its model is: on a small local model (3B or so) links, settings and how-to answers work, but it will say its CSS may be rough and suggest something better, such as `google/gemini-2.5-flash` on OpenRouter or a 14B local model.

## Streamed videos

A video you stream without downloading (`/watch?url=…`) gets the same AI panel: **Summary**, **Chat** and **Generate** chapters work from its title, description and English captions (fetched from the stream the first time you use AI on it; a stream without captions can still be chatted about from its metadata). Only YouTube videos are supported.

Results are saved per video. Opening the stream again shows them without spending tokens, and **downloading the video moves them onto the library copy** (its own summary or chapters win if it already has some; your chat joins your conversation about the video, in time order). If nobody opens the stream for `HORDE_STREAM_AI_RETENTION_DAYS` (default **30**) days and it was not downloaded, its saved results are deleted. The AI panel shows the date they are kept until. See [ADR 0010](../adr/0010-stream-ai-retention.md).

## Enrich tags

**Enrich tags** proposes tags from **title, channel, and description** (subtitle excerpt is optional when captions exist). Existing tags are respected (avoid near-duplicates), and the model is shown the library's most used tags so it reuses their exact spelling instead of inventing synonyms. Tags then appear as library chips when counts exceed the display threshold ([Library](library.md)).

Summaries still require downloaded captions; tag enrichment does not.

## Recommended tab

The library home shows:

- **Library** — normal grid
- **Recommended** — "For you", ranked from your own watch history, plus category shelves when AI is ready

**For you** works with AI off too. Without AI it ranks by what your history says: channels you watch a lot (recent and finished watches count most), tags shared with what you watched, channels you follow, and how new a video is. With AI it ranks by how close each video's content is to what you watched recently and watched through, which also finds videos from channels you have never opened. Either way it leaves out what you have already seen (it moves to the end) and mixes channels instead of filling the row from one. An [imported YouTube history](youtube-history.md) counts too: what you watched there is treated as seen, the channels you watch there (recent viewing far more than old) lift their videos, and now and then a **Throwback** pick brings back a channel or topic you watched months ago.

**Include not downloaded** (a chip beside **For you**, remembered per account) also suggests uploads of channels you follow that are not downloaded yet, marked like any other feed card with a **Download** button. They come from the channel's index, so a followed channel takes part once it has been indexed (**Index channel** on its page); with AI they are scored on the same scale as your library, from the index's embeddings.

**Categories** are invented by the chat model from a sample of the library, with the sample videos that belong to each, and refreshed with **Refresh categories**. A video is shown only under the categories it fits best, so a shelf does not fill up with videos that belong to another one. Match strictness is tunable (`category_min_score`). How the scores work: [AI pipeline](../architecture/ai-pipeline.md#recommendations). Without an AI provider there are no category chips.

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
- **Blocked** state when jobs sit waiting on the AI provider
- **Failed jobs** list with Retry / Retry all / Clear failed

See [Single-flight AI](../design/single-flight-ai.md) and [AI pipeline](../architecture/ai-pipeline.md).

## Related

- [Search](search.md) — hybrid search and subtitle indexing
- [Library](library.md) — Recommended tab
- [Import & review](import-review.md) — duplicates
- [AI settings](../settings/ai.md)
- [AI setup](../ops/ai-setup.md)
- [AI pipeline](../architecture/ai-pipeline.md)
