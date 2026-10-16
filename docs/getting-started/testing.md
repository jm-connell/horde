# Automated testing

Horde’s regression safety net is **fast, offline, and GitHub-hosted**. The goal is to catch breaks in library/API contracts, download-queue state, settings persistence, and the production image **before a merge**, and again whenever you push a large change.

This is not a substitute for playing a real video on your LAN. The player still has a short [manual smoke checklist](../reference/video-player-smoke.md).

## What to automate (and what not to)

| Layer | Tool | Runs in CI? | Protects |
|-------|------|-------------|----------|
| **Lint, format & types** | `ruff check`, `ruff format --check`, `mypy` (backend); ESLint, Prettier, `tsc --noEmit` (frontend) | Yes | Unused code, unsafe patterns, type errors (optional ids, wrong return types), hook-dependency and accessibility mistakes, style drift |
| **Backend unit** | pytest against services (paths, URL clean, queue, settings clamps, yt-dlp error kinds, migrations, `update.sh` env/mount helpers) | Yes | Logic that used to regress without an HTTP server |
| **Backend API** | pytest + FastAPI `TestClient` on a temp SQLite + temp `DOWNLOADS_DIR` | Yes | Library, review, playlists, settings, download enqueue (yt-dlp stubbed), Range streaming |
| **Frontend unit** | Vitest (node) | Yes | Formatters, presets, catalog progress copy, URL helpers |
| **Frontend build** | `tsc -b && vite build` | Yes | Type errors and a broken production bundle |
| **Browser UI** | Playwright (Chromium) against the built SPA + FastAPI | Yes | Nav, library, history, download form, playlists, import, watch chrome, settings, setup wizard, 404 and error boundary, service-worker update prompt, axe accessibility scan of every main page |
| **Wiki** | `mkdocs build --strict` | Yes | Broken nav / missing Markdown pages |
| **Container** | `docker build` of the repo `Dockerfile` | Yes | The TrueNAS/Dockge artifact (frontend + wiki + Python image) |
| **Player decode / Cast** | Manual | No | Shaka, DASH preview, mini-player reparenting, Cast, iOS — still [manual](../reference/video-player-smoke.md) |
| **Live YouTube / Ollama** | Not in CI | No | Bot checks, cookies, GPU models — flaky and network-bound |

CI **must not** call YouTube, OpenRouter, or a real Ollama. Download tests stub `extract_preview`; AI enqueue is a no-op. Playwright sets `HORDE_E2E=1`, which skips background workers, returns a synthetic download preview, and refuses to dispatch yt-dlp. That keeps the suite deterministic and offline.

!!! tip "Write a test when you fix a bug"
    If something broke in production (queue pause, device downloads, progress expiry, settings merge, update wiping host paths), add a pytest or Vitest case next to the fix. The existing files under `backend/tests/` and `frontend/src/**/*.test.ts` are the pattern.

## Quality gates (`scripts/check.sh`) { #quality-gates-scriptscheck-sh }

One script runs every gate in the order CI does and prints a summary. Run it before each commit:

```bash
scripts/check.sh          # backend + frontend + docs gates
scripts/check.sh --e2e    # also run the Playwright suite
```

| # | Gate | Command (run by the script) |
|---|------|-----------------------------|
| 1 | Backend lint | `ruff check .` in `backend/` |
| 2 | Backend format | `ruff format --check .` in `backend/` |
| 2b | Backend types | `python -m mypy` in `backend/` (configuration in `pyproject.toml`; zero errors) |
| 2c | Python lock file | `python scripts/check_requirements_lock.py` (`backend/requirements.lock` satisfies `requirements.txt`; see [Dependencies](../development/dependencies.md)) |
| 3a | API schema | `python -m app.export_openapi --check openapi.json` in `backend/` (regenerate with `... openapi.json` when you change the API) |
| 3 | Backend tests | `PYTHONPATH=. pytest -q` in `backend/` |
| 3b | API types | `npm run gen:api:check` in `frontend/` (regenerate `src/api/schema.d.ts` with `npm run gen:api` after regenerating `openapi.json`) |
| 4 | Frontend lint | `npm run lint` (ESLint, zero warnings) |
| 5 | Frontend format | `npm run format:check` (Prettier) |
| 6 | Types | `npm run typecheck` (`tsc --noEmit`) |
| 7 | Frontend tests | `npm test` (Vitest) |
| 8 | Production bundle | `npm run build` |
| 9 | Wiki | `mkdocs build --strict` (skipped when mkdocs is not installed) |
| 10 | Browser UI (`--e2e` only) | `npx playwright test` |

Every gate runs even if an earlier one fails, so you see all problems at once; the exit status is non-zero if any failed. Set `PYTHON=/path/to/venv/bin/python` to choose the interpreter (default: `.venv/bin/python` if present, else `python3`).

Auto-fixers: `ruff check --fix . && ruff format .` in `backend/`, `npm run lint:fix` and `npm run format` in `frontend/`.

Tool configuration lives in `backend/pyproject.toml` (ruff, mypy) and `frontend/eslint.config.js` / `frontend/.prettierrc`. `mypy` is a gate: zero errors, with `check_untyped_defs`, `warn_return_any`, `warn_redundant_casts`, `strict_equality` and `warn_unused_ignores` on. Every `# noqa`, `# type: ignore[code]` and `// eslint-disable` must carry a reason (mypy allows free text only after a second `#`: `# type: ignore[attr-defined]  # why`). Typing notes for SQLModel code: class attributes such as `Video.id` are typed as their Python values, so wrap them in `col()` when building SQL expressions (`col(Video.id).in_(ids)`), and use `require_id(row)` for a primary key that is known to be set.

!!! note "Playwright browser path"
    By default Playwright uses the Chromium that `npx playwright install chromium` fetches (CI does this). On a machine with a preinstalled browser that does not match the pinned Playwright version, set `PW_CHROMIUM_EXECUTABLE=/path/to/chrome`. Set `E2E_APP_PORT` / `E2E_SETUP_PORT` (defaults 8091 / 8092) to run several checkouts side by side.

## Local commands

Same commands GitHub Actions runs (`scripts/check.sh` wraps them).

Backend (from `backend/`, venv with `requirements.txt` + `requirements-dev.txt`):

```bash
pip install -r requirements.txt -r requirements-dev.txt
ruff check . && ruff format --check . && mypy
pytest
```

Frontend:

```bash
cd frontend
npm ci   # or npm install
npm run lint && npm run format:check && npm run typecheck
npm test
npm run build
```

Browser UI (from `frontend/`, after the Python deps above are installed). `npm run e2e` builds the SPA, then Playwright serves it with `e2e/serve.py` on ports 8091 (seeded library) and 8092 (setup wizard). `npm run e2e:run` skips the build when `frontend/dist` is already current.

```bash
cd frontend
npx playwright install chromium
npm run e2e
```

Two Playwright projects run the app specs: `app` (desktop Chrome, every spec) and `mobile` (Pixel 7 profile on Chromium, running the navigation, library, watch and offline specs). The seeded media is VP9 in MP4, which every Chromium build can decode (H.264 needs proprietary codecs, so it is not used). `a11y.spec.ts` runs axe-core over the main pages and fails on serious or critical violations. `a11y-states.spec.ts` does the same for states reached by interaction (an open playlist, the user editor).

Two e2e-only endpoints exist while `HORDE_E2E=1`: `POST /api/e2e/reset` restores the seeded library before every test, and `POST /api/e2e/bulk-videos?count=N` adds filler videos so a spec can cross the library's cursor page boundary (`library-paging.spec.ts`). Specs that sign in or out should do so from a fresh context: the seeded accounts' sessions are shared by every spec and survive resets.

Wiki (from the repo root):

```bash
pip install "mkdocs-material>=9.5,<10"
mkdocs build --strict
```

Optional full image (slow; matches Dockge):

```bash
docker build -t horde:local .
```

`./start.sh` is for interactive UI work, not for this suite. Tests create their own temp data dirs and never touch `./data` or `./downloads`.

## GitHub Actions (runs on every push)

The workflow file is `.github/workflows/ci.yml`. It runs on:

| Event | When |
|-------|------|
| **`push`** | Every branch you push, including `main` |
| **`pull_request`** | Opening or updating a PR (including forks) |
| **`workflow_dispatch`** | **Actions → CI → Run workflow** after a large local change if you want a fresh run without a new commit |

Jobs (parallel): **backend** (pytest), **frontend** (Vitest + production build), **e2e** (Playwright against the built SPA), **docs** (MkDocs `--strict`), **image** (`docker build` of the single-container app).

A red X on the commit or PR means “do not merge until it is green.” Open the failed job log; pytest and Vitest names map to files under `backend/tests/` and `frontend/src/`.

### After large changes

1. Push the branch (CI starts automatically).
2. Or, with no new commit, use **Run workflow** on the branch.
3. For player/CSS/Shaka work, also walk through the [video player smoke checklist](../reference/video-player-smoke.md) on your LAN.

### Optional: block merges until CI is green

On GitHub: **Settings → Branches → Add branch protection rule** for `main`.

- Require a pull request before merging (if you want that workflow)
- **Require status checks to pass**: `backend`, `frontend`, `e2e`, `docs`, `image`

Without protection, CI still **runs and reports**; it just will not physically stop a merge. For a homelab repo that is often enough if you glance at the checks.

## Adding coverage

Prefer **API tests** for anything the UI calls (`/api/videos`, playlists, settings, downloads). Use the `client` and `add_video` fixtures in `backend/tests/conftest.py` — they spin a FastAPI app with the real routers, a throwaway SQLite file, and **no** scanner/AI/catalog worker threads. Each test gets a fresh `AppContext` over a temp directory (the `tmp_dirs` fixture activates it); services read paths and the engine through it, so nothing needs patching per module. See [Application context](../design/app-context.md).

```python
def test_example(client, add_video):
    video = add_video(title="Clip", channel="Alpha")
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["title"] == "Clip"
```

Stub outbound work with `monkeypatch` (see `test_api_downloads.py` for `extract_preview`). Do not start uvicorn or Vite inside pytest.

Frontend: colocate `*.test.ts` next to the pure helper. Vitest is configured with `environment: "node"` — keep it for formatters, URL parsing, and layout math. Page chrome belongs in `frontend/e2e/` (Playwright), which drives the production bundle and must stay offline.

## Related

- [Local development](local-dev.md)
- [Video player smoke checklist](../reference/video-player-smoke.md)
- [API overview](../architecture/api-overview.md)
- [Architecture overview](../architecture/overview.md)

## Benchmarks

`backend/scripts/bench_library.py` builds a throw-away library (10 000 videos and 60 000 embedding chunks by default) and prints median timings for keyword search, tag filters, tag listings, YouTube id lookup and vector search. Run it from `backend/` with `PYTHONPATH=. python scripts/bench_library.py`; it never touches your real `DATA_DIR`. Use it before and after changing a query in `services/library.py` or the vector search.
