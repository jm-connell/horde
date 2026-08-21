# Frontend

React + Vite SPA under `frontend/`. Production build is copied to `backend/static` (and served by FastAPI). Dev uses Vite on port **5173**.

## Routes

| Path | Page |
|------|------|
| `/` | Library |
| `/history` | Watch history / continue watching |
| `/download` | Download queue & URL ingest |
| `/playlists` | Playlist list |
| `/playlists/:id` | Playlist detail |
| `/import` | Import & review queue |
| `/review` | Redirect → `/import` |
| `/settings` | Settings (tabs via query, e.g. `?tab=playback`) |
| `/watch/:id` | Watch library video |
| `/watch?url=` | Watch / preview by source URL (optional `channel`) |
| `/preview` | Legacy redirect → `/watch?…` |

Shell: `TopNav` + `BackgroundEffect` wrap routes inside nested providers.

## Providers

Mounted in `App.tsx` (outer → inner):

| Provider | Role |
|----------|------|
| `ToastProvider` | Transient toasts |
| `DownloadProvider` | Download queue state / actions |
| `SearchProvider` | Shared search query / library search coordination |
| `PlaybackProvider` | Current video, queue, mini-player, navigation into `/watch` |

## Player DOM reparenting

The media player host is **reparented** with `appendChild` (not a React portal) so the same `<video>` element can move between:

- the full watch page dock, and  
- a floating mini-player on `document.body` while browsing  

This preserves playback state across route changes without remounting the media element. See [Player architecture](../design/player-architecture.md).

## Settings hydrate + debounce

`useSettings` keeps a **module-level hydrate**: one `GET /api/settings` shared by all subscribers.

Edits patch local state immediately and **debounced sync** to the server (~**300 ms**) so typing and slider drags do not spam `PATCH /api/settings`. Appearance and AI panes follow the same pattern.

## Key UI modules

| Area | Notes |
|------|--------|
| `pages/Library.tsx` | Browse composition; sidebar/bulk helpers live in `ChannelSidebar`, `LibraryBulkBar`, `libraryCatalogProgress` / `libraryStorage` |
| `components/VideoPlayer.tsx` | Orchestration; types/quality in `videoPlayerTypes` / `videoPlayerQuality`; DASH load in `hooks/useShakaDash`; overlays in `PlayerOverlays` |
| `hooks/useSettings.ts` | Hydrate + debounced PATCH; `ViewMode` type from `videoPlayerTypes` |
| `customCss.ts` | User CSS overlay (`#horde-custom-css`) and `data-page` / `data-horde` hooks |

## Related

- [Overview](overview.md)
- [Settings overview](../settings/index.md)
- [Watching](../guides/watching.md)
- [Video player](../guides/player.md)
