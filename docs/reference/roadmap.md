# Roadmap

!!! info "Original roadmap (may be partially obsolete)"
    This page adapts the historical phased plan from the repo’s `roadmap.md`. **Many Phase 1–5 items may already be implemented** in the current app (for example History, SponsorBlock, themes, and a substantial AI layer). Treat this as a **historical roadmap and idea backlog**, not a live status board. **See the running app** (and this wiki’s guides) for what actually ships today.

## Phase 1 — Daily-use polish (original “done”)

Focus: watch page/player polish, mobile foundation, download queue UX, resume / continue watching.

Examples from the original list:

- Overflow menu actions (edit, delete, source, direct download)
- Theater / standard sizing, persistent volume and mode
- Desktop mini popout, mobile nav and mini bar, best-effort auto PiP
- Background download queue with editable title/channel and nav badge
- Per-video resume and continue-watching row

Much of this is foundation the current UI still rests on.

## Phase 2 — Player, mobile & playback bugs

High-impact watching fixes, especially iOS:

- Larger mini-player tap targets; aspect-ratio mini player
- Double-tap / first-interaction play feel
- Prefer inline `playsInline` over aggressive native fullscreen hijack
- Theater mode disappear bug; hold-to-2x continues on release
- Subtitle centering; remove leftover inline source link
- Settings cleanup (description toggle alignment; drop redundant default mode section)

Some items may still be relevant as polish; verify on your devices rather than assuming open/closed from this page.

## Phase 3 — Library, homepage & browse UX

- Continue watching: visual separation, per-item dismiss, clear all, settings toggle, progress bars, desktop single-row vs mobile scroll
- **History** tab from watch progress timestamps
- Sorting: file size, view count, random re-seed; tag chip limits
- Channel sidebar sort options and hover edit affordance
- Personal notes below description on watch

!!! note "Likely present now"
    History, richer sorting, continue-watching controls, and channel sort settings have landed in various forms — check [Library](../guides/library.md) and [History](../guides/history.md).

## Phase 4 — Download pipeline & media management

- FIFO concurrency (limited active downloads), pause, smarter card dismiss (cancel vs remove-from-list)
- Autofill / thumbnail / notes on download cards
- Quality preset audit; redownload at another resolution from watch menu
- Optional post-download **loudnorm** / volume normalization

Download queue and normalize options continue to evolve; see [Downloads](../guides/downloads.md).

## Phase 5 — Themes, health, content features, AI & platform

Originally the “large features” bucket:

| Theme | Original ideas |
|-------|----------------|
| Homelab polish | Themes (OLED, terminal, …), health dashboard, PWA icons |
| Playback intelligence | SponsorBlock, chapters from description, duplicate detection, “more like this” |
| Metadata | Periodic refresh; respect custom title/description |
| AI layer | NL search, auto-tags from subs/notes, AI duplicates/playlists/recs, auto-translate |
| Platform | Bulk select, followed-channel feed, browser extension, next-chapter hotkey, &gt;60fps manual files |

!!! note "Honest status"
    Themes, SponsorBlock, chapters, health-ish system info, bulk select, and a broad AI layer (Ollama / OpenRouter, embeddings, recommendations) are **largely present** in current builds. Browser extension, full offline PWA, and some feed/extension ideas remain closer to “future / out of scope for now.” Prefer the app over this table for truth.

## Original recommended build order

1. Phase 2 — theater / hold-2x / mobile taps  
2. Phase 4 (partial) — FIFO, card actions, quality bugs  
3. Phase 3 — continue watching, sorting, history  
4. Phase 5 — themes, health, AI when prioritized  

History may not have followed that order strictly once vibecoding accelerated.

## Open decisions (from the original doc)

| Topic | Options considered |
|-------|--------------------|
| Continue watching dismiss | Clear progress vs hide from row only |
| Pause download | True yt-dlp pause vs queue gate |
| Channel sub count sort | N/A for non-YouTube / manual channels |
| Auto-translate | Ollama-only vs external API |
| Volume normalization | Off by default vs optional ffmpeg on download |

## Originally out of scope (for then)

- Browser extension (large)
- Full offline PWA
- AI until explicitly prioritized (later became a major track anyway)

## Related

- [Why Horde](../design/why-horde.md)
- [Vibecoded](../design/vibecoded.md)
- [FAQ](faq.md)
