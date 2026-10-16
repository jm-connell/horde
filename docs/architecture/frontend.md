# Frontend

React + Vite SPA under `frontend/`. The Docker build compiles it into `/app/static`, and `npm run build:sync` does the same locally into the gitignored `backend/static` (served by FastAPI). Dev uses Vite on port **5173**.

## Routes

| Path | Page |
|------|------|
| `/` | Library |
| `/history` | Watch history / continue watching |
| `/offline` | Videos saved on this device (works without the server) |
| `/download` | Download queue & URL ingest |
| `/playlists` | Playlists (expand a row; `?open=<id>` opens one) |
| `/playlists/:id` | Redirect → `/playlists?open=:id` |
| `/import` | Import & review queue |
| `/review` | Redirect → `/import` |
| `/settings` | Settings (tabs via query, e.g. `?tab=playback`) |
| `/setup` | First-install / post-reset wizard (hidden after `setup_completed`) |
| `/watch/:id` | Watch library video |
| `/watch?url=` | Watch / preview by source URL (optional `channel`) |
| `/preview` | Legacy redirect → `/watch?…` |

Shell: `TopNav` + `BackgroundEffect` wrap routes inside nested providers. Until `setup_completed` is true, only `/setup` is shown (no nav).

## Providers

Mounted in `App.tsx` (outer → inner):

| Provider | Role |
|----------|------|
| `ErrorBoundary` (`scope="app"`) | Last-resort render-error page; routes get their own boundary inside `<main>` |
| `ToastProvider` | Transient toasts |
| `ConfirmProvider` | Promise-based confirm dialogs |
| `AuthProvider` + `AuthGate` | Who is signed in and their permissions; shows sign-in or *Create the admin account* instead of the app. `RequirePermission` hides routes and controls the account cannot use (the server enforces) |
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

See also the [architecture map](../design/architecture.md#frontend) for where new frontend and backend code belongs.

## Related

- [Overview](overview.md)
- [Settings overview](../settings/index.md)
- [Watching](../guides/watching.md)
- [Video player](../guides/player.md)
