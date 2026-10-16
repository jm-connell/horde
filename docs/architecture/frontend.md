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
| `ToastProvider` | Transient toasts (stable value) |
| `ConfirmProvider` | Promise-based confirm dialogs |
| `AuthProvider` + `AuthGate` | Who is signed in and their permissions; shows sign-in or *Create the admin account* instead of the app. `RequirePermission` hides routes and controls the account cannot use (the server enforces) |
| `QueryClientProvider` (inside the sign-in gate, keyed by user id) | The TanStack Query cache for the signed-in account (see [Data layer](#data-layer)) |
| `DownloadProvider` | Download jobs, live progress and queue state, kept in the query cache |
| `SearchProvider` | Shared search query / library search coordination |
| `PlaybackProvider` | Current video, queue, mini-player, navigation into `/watch`; three contexts (below) |

`PlaybackProvider` exposes `usePlaybackActions()` (stable, never re-renders a reader), `usePlaybackSession()` (current video, stream, queue, mode) and `usePlaybackLayout()` (mini-player rectangle, picture inset, live quality; these change while dragging). Read the narrowest one a component needs.

## Data layer

Server data is read through **TanStack Query** (`src/queries/`). Types come from the generated OpenAPI schema (`src/api/schema.d.ts`, see [API overview](api-overview.md)); `src/types.ts` aliases them.

- One query key per resource (`queries/keys.ts`), so screens share a request and a returning screen paints the cached value while it revalidates. Status data (AI status, system stats, activity, catalog and metadata sync) polls only on the screens that show it, and not in background tabs.
- The library list is a `useInfiniteQuery` over the cursor API: the first page paints, the rest streams in, a failed page keeps the pages already loaded, and a refetch replaces the list only when every page has arrived.
- Download jobs and per-job progress live in the cache: SSE events go in with `setQueryData`, and polling is only a fallback while the stream is down.
- Writes are `useMutation` calls that invalidate or update the cache; a failure with no inline handling goes through `showError`.
- The client uses `networkMode: "always"` because offline mode is tracked by `offline/connectivity`, and each signed-in user gets a new client and a remounted subtree, so nothing of the previous account survives a user change.

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
| `pages/Watch.tsx` | Wiring and layout only. The pieces are in `pages/watch/`: `useWatchVideo` (library or stream-preview load, keeps the page copy current, a failed refresh never replaces a video already shown), `useStreamDownload` + `StreamDownloadControl` (download a previewed stream), `useWatchActions` + `WatchActions` + `RedownloadDialog` (edit, change resolution, normalize, delete), `useWatchAi` (AI flags, chapter generation), `useRelatedFeed` + `WatchSidebar` (related videos), `WatchPlayerSection` (player dock, `SourceChangeBanners`, `WatchHeader`) and `WatchInfoPanels` (AI panel, description, chapters, tags) |
| `pages/Settings.tsx` | Tab bar, search box, and `?tab=` / `?pane=` routing only; admin-only tabs are gated here. Each tab owns its state and polling through its own hook in `pages/settings/`: `useAppearanceState`, `useLibraryState`, `useSystemState`, and `ai/useAiCore` (shared by the AI and System tabs) with `ai/useAiPanes`. The shared `SettingsPageContext` carries only the search query and the client preferences. The AI pane and provider sub-pane (`ai/useAiPaneState`) are held by the page so they survive a tab switch. Large tabs are split into section components (`appearance/`, `system/`, `ai/LocalProviderPane`, `ai/OpenRouterProviderPane`) |
| `components/VideoPlayer.tsx` | Orchestration; types/quality in `videoPlayerTypes` / `videoPlayerQuality`; DASH load in `hooks/useShakaDash`; overlays in `PlayerOverlays` |
| `hooks/useSettings.ts` | Hydrate + debounced PATCH; `ViewMode` type from `videoPlayerTypes` |
| `customCss.ts` | User CSS overlay (`#horde-custom-css`) and `data-page` / `data-horde` hooks |

See also the [architecture map](../design/architecture.md#frontend) for where new frontend and backend code belongs.

## Related

- [Overview](overview.md)
- [Settings overview](../settings/index.md)
- [Watching](../guides/watching.md)
- [Video player](../guides/player.md)
