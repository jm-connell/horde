# Horde: guidance for contributors and AI coding agents

Horde is a self-hosted video library and downloader with accounts (one admin plus members; trusted LAN). One FastAPI process serves the JSON API, streams media, runs background workers and hosts the built React SPA.

## Architecture

- `backend/app/main.py`: FastAPI app and `lifespan`. Startup order: `ensure_dirs`, `init_db`, orphan cleanup, queue recovery (`download_queue.recover()`, `recover_ai_jobs`, `recover_catalog_jobs`), then the worker threads.
- `backend/app/api/`: one router per area (`videos`, `downloads`, `preview`, `review`, `playlists`, `channels`, `app_settings`, `ai`, `system`, `setup`, `backgrounds`, `fonts`, `compat`). Routers stay thin; logic lives in services.
- `backend/app/services/`: all business logic. Notable modules: `downloader` (yt-dlp queue and ffmpeg postprocess, also a facade that re-exports helpers from `ytdlp_extract` / `ytdlp_formats`), `scanner` (watchdog + poll of `DOWNLOADS_DIR`), `library`, `metadata`, `sprites`, `thumbnails`, `compat_rendition` (H.264 sidecars), `stream_preview` (DASH preview of not-yet-downloaded videos), `app_settings` (JSON settings), `auth/` (accounts, sessions, permissions, signed media URLs), `user_state` / `user_settings` (per-user history and UI preferences), `ai/` (embeddings, tags, chapters, chat, OpenRouter/Ollama providers, cost ledger), `channel_catalog/` (channel indexing).
- Workers are plain daemon threads started in `lifespan`: scanner, metadata sync, AI (single-flight), channel catalog (one at a time), channel autodownload, subtitle retry, job metadata, plus the download queue's own pool. They are skipped when `HORDE_E2E` is set.
- `backend/app/models.py` (SQLModel tables and status enums), `schemas.py` (request/response models), `config.py` (env-derived paths and settings), `database.py` (engine, WAL, migrations).
- DB: SQLite at `DATA_DIR/horde.db`, schema managed by Alembic (`backend/app/migrations/`, batch mode, foreign keys enforced). `init_db()` upgrades to head at startup: fresh DB -> `upgrade head`; pre-Alembic DB -> frozen `legacy_migrations.py` then `upgrade head`; unknown (newer) revision -> refuse to start. Delete videos only through `services/video_delete.delete_video_cascade`.
- `frontend/src/`: React 18 + TypeScript + Vite + Tailwind. `pages/` (Library, Watch, Download, Import, Playlists, History, Settings, Setup, Offline), `components/`, `context/` (Playback, Download, Search, Toast, Confirm providers), `hooks/`, `api.ts` (typed fetch client), `offline/` (service worker, IndexedDB, offline downloads), `types.ts`.
- `frontend/e2e/` Playwright specs; `e2e/serve.py` starts the app with a seeded temporary library (`HORDE_E2E=1`, ports 8091 app / 8092 setup wizard; override with `E2E_APP_PORT` / `E2E_SETUP_PORT`).
- `docs/` is the MkDocs wiki (also shipped at `/wiki`); `docker/` and `Dockerfile` build the single-container image.

## Mandatory gate

Run `scripts/check.sh` before every commit (add `--e2e` when you touch UI or API behaviour the UI uses). It runs, in order: `ruff check`, `ruff format --check`, `pytest`, `eslint --max-warnings 0`, `prettier --check`, `tsc`, `vitest`, `vite build`, `mkdocs build --strict`. CI runs the same gates; a red gate is never acceptable to merge. Details: `docs/getting-started/testing.md`.

Backend commands (from `backend/`): `PYTHONPATH=. pytest -q`, `ruff check .`, `ruff format .`. Frontend (from `frontend/`): `npm run lint`, `npm run format`, `npm run typecheck`, `npm test`, `npm run build`. `mypy` is configured in `backend/pyproject.toml` but is not a gate yet.

## Conventions

- No new broad `except Exception` without logging the error (`logger.exception` / `logger.warning(..., exc_info=True)`). Silent `pass` handlers are not acceptable and none remain: `tests/test_code_conventions.py` fails on any `noqa: S110` / `SIM105` or a `noqa` without a reason, and ruff (`S110`, `BLE001`) has no per-file exemptions. Log at `debug` for routine, noisy failures and `warning` otherwise, with `exc_info=True`.
- Every `# noqa` and `// eslint-disable` needs a reason after ` - ` / ` -- `. Fix the finding instead whenever it is cheap.
- No new module-level mutable state in new code (module dicts/sets/locks that tests have to reset). Hold state on an object that is created in `lifespan` or injected, so tests can build a fresh one.
- New endpoints declare `response_model` (and request models in `schemas.py`); do not return ad-hoc dicts.
- Schema changes are Alembic revisions: edit `models.py`, run `cd backend && alembic revision --autogenerate -m ... --rev-id NNNN_name` against a scratch `DATA_DIR`, review it, never edit an existing revision. `tests/test_database_migrate.py` fails when models and revisions drift. See `docs/design/sqlite-and-migrations.md`. Never edit the DB by hand in code paths.
- Prefer end-to-end tests: Playwright for UI behaviour, FastAPI `TestClient` for API behaviour. Add a unit test for a real bug regression or pure logic. Never skip or weaken a test to get green; fix test isolation instead.
- Tests must be order independent. Background threads started by a test must be joined before it ends (see the autouse fixture in `backend/tests/conftest.py`).
- Frontend: fix `react-hooks/exhaustive-deps` properly; an intentional omission needs a disable with a `-- reason`. Clickable non-button elements need a role and keyboard handling; form controls need an associated label.
- Security (details: `docs/ops/security.md`, `backend/app/security.py`): every non-GET request needs the `X-Horde-Request` header. `frontend/src/api.ts` adds it automatically; any new `fetch` / `XMLHttpRequest` that mutates must use `withCsrf()` / `CSRF_HEADER`, and tests that call the API directly send it too (the `client` fixture does). No destructive GETs: a GET only serves what exists. User-supplied URLs go through `services/url_safety.py`, uploads through `services/uploads.py`, and links rendered from stored data through `safeHref()`. Middleware order lives in one list (`build_stack`); auth slots in after `CsrfMiddleware`.
- Auth: every `/api` route is protected by default (`AuthMiddleware`, `app/auth.py`); only the exact list in `PUBLIC_ROUTES` is open. Routes that change server-wide state declare `dependencies=[Depends(require_admin)]`; routes a member may only use with a grant declare `require_permission("...")` (names in `services/auth/permissions.py`). `tests/test_permissions.py` fails when a mutating route is not classified. Get the user with `Depends(current_user)`; never trust a client-supplied user id.
- Watch history is per user: read and write `user_video_state` (`services/user_state.py`), pass `user_id` to `library.query_videos` and `video_serialize.to_read`. Never read or write `videos.last_position_sec` / `videos.last_watched_at` (legacy columns, kept only so the first admin can adopt them). AI chat messages carry `user_id`.
- Update `docs/`, `README.md` and `.env.example` in the same change when behaviour or configuration changes.
- Commits: small, one concern each, imperative subject under 72 characters, a body explaining why. Mechanical reformatting goes in its own commit.
