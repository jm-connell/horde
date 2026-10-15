# Remaining packages (briefs)

These run after WP-F (runtime) and WP-G (auth) are merged. Read the review file's relevant rows.

## WP-H1: API contract (backend), in worktree /home/user/wt/api
1. Every JSON route declares a `response_model`. Binary, streaming and SSE routes declare `responses=` with their media type. Create pydantic models in `schemas.py` (or `schemas/` split by area if that file grows past ~800 lines) for every ad-hoc dict return. List of known gaps: health, system stats/activity, updates, ai test/openrouter test/pause/resume/jobs actions/recommendations/categories, compat summary/cancel, fonts, backgrounds, video ai chat GET/DELETE, `PATCH /api/channels` (which uses `response_model=dict`). Enumerate with `iter_route_contexts` and add a test that fails if any JSON route lacks a response model (explicit allowlist for binary/stream/SSE routes).
2. One error envelope:
   - `{"detail": "<human message>", "code": "<snake_case>", "fields"?: [...], "extra"?: {...}}` for every error, produced by exception handlers for HTTPException, RequestValidationError (422 → `code: validation_error`, `fields: [{loc, msg}]`), the app's own domain exceptions, and an unhandled-exception 500 handler (generic message, request_id echoed, traceback logged).
   - Keep `detail` a string, so the frontend's existing parsing keeps working. Migrate the endpoints that raise `detail` as dicts (`downloads.py` ~170, `_duplicate_detail`) to `code` + `extra`.
   - Update `frontend/src/api.ts` `ApiError` to read `code`/`fields`/`extra`, and `apiErrors.ts`.
   - Tests.
3. Pagination:
   - `GET /api/videos` and `/api/review` take `limit` (default 100, max 500) and a stable cursor (keyset on the active sort key + id). Response: `{items, next_cursor, total?}`. Return total only when cheap, or behind a flag.
   - `/api/playlists`, `/api/review/groups` and `/api/tags*`: bound them or paginate as sensible.
   - Bulk endpoints already have caps.
   - IMPORTANT: the frontend must be updated in the same package to page through results (Library grid infinite scroll or "load more", review queue). Keep the UX identical for libraries under ~500 videos (fetch pages eagerly in the background). The e2e suite must pass.
4. N+1 in `to_read` (`api/video_serialize.py`): batch-load VideoAiMeta, per-user state and AI job status for a page of videos with `IN` queries. Make `has_thumbnail`/`sprites_exist` DB-derived (store flags or paths) instead of filesystem `stat()` per row. Add a test asserting the query count for a 50-video page stays constant (SQLAlchemy event counter).
5. Remove duplicate routes (`/api/channels/youtube-search` vs `/api/youtube/search`): keep one and redirect or alias the other for one release with a deprecation log.
6. Versioning: add `/api/v1` as the canonical prefix. Keep `/api` as an alias mounted to the same routers for backward compatibility. The frontend switches to `/api/v1`. Document the deprecation policy. If this turns out invasive with the security/auth middleware path matching, document why and skip it (a question for the owner).

## WP-H2: Frontend data layer, in worktree /home/user/wt/fdl (after H1 merges)
1. OpenAPI codegen:
   - `openapi-typescript` generates `src/api/schema.d.ts` from the backend's `/openapi.json`. Export it via a script that imports the FastAPI app (no server needed): `python -m app.export_openapi > openapi.json`.
   - Add `npm run gen:api`. A CI job (and check.sh) fails if the generated file is stale.
   - Use `openapi-fetch` (or keep `api.ts` request() but type it from the generated paths).
   - Remove hand-maintained types in `types.ts` that duplicate API shapes. Keep UI-only types.
2. TanStack Query:
   - Add `@tanstack/react-query` and a QueryClient in App with sensible defaults (`staleTime` per resource, `refetchOnWindowFocus` for status data, `refetchIntervalInBackground: false`).
   - Migrate in this order, one commit per area, e2e green after each:
     - (a) Settings pollers (AI status, system stats, activity, compat summary), deduped with the TopNav/Library AI status poll.
     - (b) DownloadContext: SSE pushes into `queryClient.setQueryData`, and the 10s/5s polls are removed or kept only as fallback.
     - (c) Library list (with H1's pagination: `useInfiniteQuery`), channels and tags.
     - (d) Watch page video and related.
     - (e) Playlists and history.
   - AbortSignal cancellation is automatic. Remove the hand-rolled `cancelled` flags as each site migrates.
   - Mutations use `useMutation` plus invalidation, and surface errors via `showError`.
3. Memoize PlaybackContext's value and split it into state and actions contexts (or a small zustand store with selectors). Make ToastContext's value stable.

## WP-J1: downloader package split (backend), worktree /home/user/wt/dlsplit
- Split `services/downloader.py` into a package `services/downloads/`: `queue.py` (DownloadQueue), `ffmpeg_queue.py`, `runner.py` (the yt-dlp attempt loop), `postprocess.py`, `finalize.py`, `jobs.py` (CRUD, dedupe, quality change), `playlist_import.py`, `progress.py`, `staging.py`, `errors.py`.
- Keep `services/downloader.py` as a thin facade re-exporting the public names for one release, then update every importer to the new modules and remove private-name imports across modules (`progress_store` etc.).
- Replace the 12-positional-arg handoffs with a `PostprocessTask` dataclass.
- Break `_run_download` and `_complete_download` (complexity 87) into named steps of complexity under ~15 each.
- Characterization first: before moving code, add end-to-end queue tests (fake extractor) that pin current behaviour for: success, cookie retry, format fallback, cancel, pause/resume, replace, playlist attach, device destination, unplayable reject, shutdown requeue. They must pass before and after.
- Pure moves and refactors: no behaviour change. radon cc on the new package: no function graded worse than C.

## WP-J2: backend AppContext, worktree /home/user/wt/ctx (after J1)
- An `AppContext` (settings, engine/session factory, paths, queues, worker registry, auth runtime, caches), built in lifespan and stored on `app.state`. FastAPI dependencies `get_ctx`, `get_session`.
- Replace the `from ..config import DOWNLOADS_DIR`-style frozen imports in services with `ctx.paths` or a `get_paths()` accessor. Do this incrementally; at minimum, services touched by J1 and every API router.
- Remove the reflective monkeypatch-every-module logic in `tests/conftest.py` in favour of building a fresh AppContext per test.
- Remove e2e branching from production code paths (`_e2e_browser()` in lifespan/dispatch) in favour of a context flag or injected no-op workers.
- Remaining module-level mutable state: either moved onto the context or listed in docs with a reason.

## WP-J3: frontend decomposition, worktree /home/user/wt/fdec (after H2)
- VideoPlayer.tsx (~2700 lines): extract `usePlayerKeyboard`, `ControlBar` (+ ScrubBar, VolumeControl, QualityMenu), `useChapters`, `useSkipSegments`, `MiniPlayerFrame`, and a reducer for player UI state. Target: no file over ~600 lines; behaviour identical (e2e + keyboard spec).
- Library.tsx: `useLibraryQuery` (URL ↔ filters), `ChannelHeader`, `LibraryGrid` with `@tanstack/react-virtual` virtualization for large libraries, `BulkSelection` reducer.
- Settings.tsx: each tab owns its state and polling.
- useSettings.ts: split into schema/migrations/applyToDom/hook.
- Watch.tsx: `useWatchVideo`, `WatchPlayerSection`, `WatchActions`, `WatchSidebar`.

## WP-M: data modelling, worktree /home/user/wt/model (parallel with H1 and J1)
- Alembic revision(s) after auth's head.
- `video_tags(video_id FK CASCADE, tag, source ['user'|'ai'|'source'], PK(video_id, tag, source))` with an index on tag. Data-migrate from `Video.tags` / `VideoAiMeta.ai_tags` / `user_tags` JSON. Library tag filters, `all_tags` and `tag_stats` use SQL. Keep the JSON columns readable for one release but stop writing them, or keep them in sync via the service layer; choose and document.
- FTS5 virtual table `videos_fts(title, description, notes, channel, tags)`, kept in sync by triggers or the service layer. Keyword search uses it (with fallback to LIKE when FTS5 is unavailable). Escape user input properly; fix the unescaped LIKE wildcards.
- `videos.youtube_id` (indexed, backfilled from source_url/file_path). `find_video_by_youtube_id` uses it; no full-table scans.
- Vector search: numpy-vectorised cosine over a cached matrix (invalidated on embedding change), or sqlite-vec if it installs cleanly from PyPI wheels on amd64 and arm64. Benchmark for 10k videos × chunks and report.
- Timestamps: introduce a `UtcDateTime` TypeDecorator for new columns; convert existing VARCHAR timestamp columns only if it's safe and tested.
