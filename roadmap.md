# Horde Roadmap

Phased plan for Horde development. Phase 1 is complete; Phases 2–5 are next.

---

## Phase 1 — Done

Daily-use polish, download workflow, and playback persistence.

### Watch page & player
- Source link in `...` menu (not inline under title — see Phase 2 for removal of any leftover inline link)
- `...` overflow menu: edit, delete, source link, direct download (local file)
- Theater mode: native aspect ratio, ~85% viewport width
- Standard player one size step bigger
- Controls stay visible while watching
- Persist volume and theater/normal mode globally
- Bigger desktop mini popout (~2×)
- Channel-scoped tags on channel pages
- Subtitle dedup (`en` vs `en-orig`)
- Resolution tags on watch page and library cards

### Mobile foundation
- Responsive top nav (hamburger on small screens)
- Edge-to-edge watch layout on mobile
- Simplified mobile controls (no volume slider, PiP/Theater/Fullscreen buttons)
- Bottom mini player bar when navigating away
- Auto PiP on app background (best-effort; iOS limitations apply)

### Download queue
- Background downloads; multiple jobs queued
- Always-visible title/channel fields on download form
- Channel picker (dropdown or search if 30+ channels)
- Download cards with progress; editable title/channel
- Completed cards with watch link
- Homepage refresh when download completes
- Active download count badge on nav

### Resume playback
- Save watch position per video
- Auto-resume on open
- Continue watching row on library home

---

## Phase 2 — Player, mobile & playback bugs

High-impact fixes for daily watching, especially on iOS.

### Mobile & mini player
- **Larger tap targets** on mini player: play, expand, close
- **Mini player matches video aspect ratio** (not forced wide bar)
- **Fix double-tap to play** on mobile (first interaction should feel natural)
- **Reduce iOS native fullscreen hijack** — prefer custom inline player (`playsInline`) for portrait playback, hold-to-2x, PiP/mini player
- **Fullscreen without distractions** — avoid Dynamic Island / system volume UI where possible; video only
- **PiP + subtitles** — captions visible and correctly positioned in Picture-in-Picture

### Playback behavior
- **Theater mode disappear bug** — opening a new video while theater mode is remembered, then toggling off, hides the player; also affects theater → fullscreen transitions
- **Hold-to-2x** — on release, **continue playing** instead of pausing
- **Speed selector** — remove **1.75x** for cleaner layout

### Subtitles & metadata UI
- **Center subtitles horizontally**
- **Remove source link** from line under title (keep only in `...` menu)

### Settings cleanup
- Fix **Show description** toggle misalignment when ON
- **Remove Default playback mode** section (player remembers last-used mode)

---

## Phase 3 — Library, homepage & browse UX

Finding, sorting, and organizing the library.

### Continue watching
- **Visual separation** from main library grid
- **Per-video X** to remove from row
- **Clear all** button
- **Settings toggle** to hide continue watching entirely
- **Desktop**: show only what fits in one row (no horizontal scrollbar)
- **Mobile**: keep horizontal scroll
- **Progress bar** on each continue-watching card

### History
- New **History** tab — full scrollable watch history (from `last_watched_at` / progress)

### Sorting & filters
- **Sort by file size** (asc/desc; default **largest first**)
- **Sort by view count** (requires storing view count from metadata)
- **Random sort** — clicking sort-direction arrow **re-randomizes**
- **Tags**: hide tags with **≤3** uses; show **max 20** + “Show more”

### Channel sidebar
- Default sort: **most recent completed download**
- **Settings**: channel list sort options — recent download, video count, alphabetical, subscriber count (where available); asc/desc each
- **Edit icon** on channel name: show **on hover only**

### Personal notes
- Show user note **below expanded description** on watch page with clear separation from YouTube description
- (Download card “Add Note” lives in Phase 4)

---

## Phase 4 — Download pipeline & media management

Queue behavior, quality, and file management.

### Download queue & cards
- **FIFO concurrency** — max **1–2 active downloads** at a time (not unlimited parallel threads)
- **Pause** on download card
- **X on cards**:
  - In progress → **cancel** (confirm); stop job
  - Completed → **remove from list only** (file stays in library)
- **Autofill title + channel** on in-progress card; **fix channel** not showing correctly
- **Thumbnail** on download card
- **Add Note** on card (beside Save changes) → saves to video notes

### Quality & redownload
- **Bug**: 1080p selected but file saved as 720p — audit format presets and yt-dlp fallbacks
- **Redownload at different resolution** from watch page `...` menu:
  - Confirm replacing existing file
  - Toast if requested quality unavailable

### Volume normalization
- Downloaded files do **not** include YouTube’s playback loudness normalization
- Optional: post-download **ffmpeg loudnorm**, ReplayGain tags, or setting to normalize on import

---

## Phase 5 — Themes, health, content features, AI & platform

Larger features and intelligence layer.

### UI & homelab polish
- **Themes** — OLED, terminal, macOS, etc.
- **Health dashboard** — yt-dlp version, disk space, Ollama status, last scanner run, pending review count
- **PWA** — favicon as install icon on iOS/Android; manifest/icons

### Playback & library intelligence (non-AI)
- **SponsorBlock** — playback-only skips; inconspicuous cue; settings to disable skip or notification
- **Chapters** from description — click to seek; segmented progress bar
- **Duplicate detection** — heuristic groups in review tab; avoid double-detecting same file
- **Collapsible “More like this”** — channel + tags first; AI similarity later

### Metadata refresh
- Periodic or on-demand refresh of **view count, description, title**
- If user has **custom title/description**: prompt **overwrite vs keep mine** on next open

### AI layer (when ready)
- Natural-language search + auto-tags from title, description, **subtitles**, and **personal notes**
- AI duplicate confirmation
- AI “more like this”, AI playlists, homepage recommendations
- **Auto-translate** non-English descriptions (Ollama or translation API)

### Platform & power features
- Bulk multi-select on library/channel
- Followed channels feed + click to download
- Browser extension “Save to Horde”
- Next chapter hotkey (after chapters)
- >60fps support for manually added videos (low priority)

---

## Recommended build order

1. **Phase 2** — theater bug, hold-2x, mobile tap targets
2. **Phase 4** (partial) — FIFO queue, card X, channel autofill bug, 1080p bug
3. **Phase 3** — continue watching polish, sorting, history
4. **Phase 5** — themes + health; AI when ready

---

## Open decisions

| Topic | Options |
|-------|---------|
| Continue watching X | Clear progress vs hide from row only |
| Pause download | True yt-dlp pause vs queue-only “don’t start next” |
| Channel sub count sort | Show N/A for non-YouTube/manual channels |
| Auto-translate | Ollama-only vs external translation API |
| Volume normalization | Off by default vs optional ffmpeg pass on download |

---

## Out of scope (for now)

- Browser extension (Phase 5, large)
- Full offline PWA (Phase 5 partial)
- AI until explicitly prioritized (Phase 5)