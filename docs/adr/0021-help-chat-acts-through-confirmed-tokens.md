# 0021. Ask about Horde links and acts through tokens the user confirms

Status: Accepted

## Context

Ask about Horde ([0018](0018-help-chat-retrieval.md)) could only describe where things are. People wanted it to take them to a setting, change it, answer about their own downloads and library, queue a download, build a playlist and write custom CSS. Many installs run small local models that are poor at tool calling, and every provider streams plain text. A model that writes free-form URLs or JSON invents settings and values; one that acts on its own can change something the user did not want, or be steered by text it read.

## Decision

- **One catalog of settings.** `backend/app/services/ai/help_catalog.json` lists the pages and about 95 settings: label, tab and pane, the `data-setting` anchor on the page, who may see it, and `chat: change` or `chat: link`. Only non-destructive, cheap and reversible settings are `change` (appearance, playback, library display, a few administrator switches such as YouTube search, Recommended+ and the video chat). Anything sensitive, costly or hard to undo (AI provider and keys, models, budget, the AI features that run per download such as summaries, chapters and tags, two-step sign-in, storage limit, download format, reset, pausing AI) is `link` only. A card for a server-wide setting says it changes it for everyone. The server validates the file (`help_catalog.parse`); tests check every anchor exists on its page, every key exists where it is saved, and every value survives the frontend's own settings normalizer.
- **Tokens, not tools.** The model writes `[[page:id]]`, `[[setting:id]]`, `[[video:id|title]]`, `[[set:id=value]]`, `[[download:url]]`, `[[playlist-new:name|ids]]`, `[[playlist-add:id|ids]]` and ```` ```css ```` blocks. Each prompt lists the pages, the settings that best match the question (keyword-ranked, at most 14) and the token rules. The panel reads the same catalog (`GET /api/ai/help/catalog`, filtered for the user) and renders links in place and actions as cards under the finished reply. An unknown id renders as plain text; an invalid value or a link-only setting gets a link and a reason, never a button.
- **Nothing happens until the user presses a button.** Cards apply through the same paths as the rest of the app (the settings hook, `PATCH /api/settings`, `POST /api/downloads`, the playlist API), so every permission check and validation applies. Setting changes and kept CSS have Undo. CSS is previewed in its own style tag (one preview at a time) for 20 seconds with a Keep / Revert bar; ordinary rules cannot move the bar, and a rule that hides it anyway is undone by the timer or Escape. `?nocss` on any URL turns custom CSS off for the tab.
- **The user's data only with consent, and only what a question needs.** `services/ai/help_data.py` reads data only for a question about the user's own things ("my downloads", "did I watch", "what should I watch", "make a playlist"); how-to questions get none. The words of the question and the page then pick topics (downloads, history, playlists, library, search, suggestions), sent as short fixed-size blocks read as that user sees them. The **Use my data** setting (Settings → Library) is per user (`helpChatData`) and is sent with each question as the consent level; the server drops the data when consent given for a local provider meets a cloud one, and keeps search words away from a cloud embedding provider under local consent.
- **A model fit for the job.** An optional **Assistant model** (`ai.help_model`) lets the administrator give the assistant a stronger model than the bulk jobs. The model's rough strength comes from its name (`help_model.tier`); small models are told to say their CSS is unreliable and what to use instead.

## Consequences

- Works with any streaming chat model; a small one may still pick the wrong id, but it can only produce a link or a card the user can ignore.
- A new setting the assistant should know about needs a catalog entry and a `data-setting` anchor; the tests fail when either goes missing.
- Topic detection is by keyword: a question about the user's data phrased without any of the words may get no data and an answer that says so.
- Library data sent to a cloud provider is bounded (a few dozen short lines) and named in the consent notice.
