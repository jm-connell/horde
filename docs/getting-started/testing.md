# Automated testing

Horde’s regression safety net is **fast, offline, and GitHub-hosted**. The goal is to catch breaks in library/API contracts, download-queue state, settings persistence, and the production image **before a merge**, and again whenever you push a large change.

This is not a substitute for playing a real video on your LAN. The player still has a short [manual smoke checklist](../reference/video-player-smoke.md).

## What to automate (and what not to)

| Layer | Tool | Runs in CI? | Protects |
|-------|------|-------------|----------|
| **Backend unit** | pytest against services (paths, URL clean, queue, settings clamps, yt-dlp error kinds, migrations, `update.sh` env/mount helpers) | Yes | Logic that used to regress without an HTTP server |
| **Backend API** | pytest + FastAPI `TestClient` on a temp SQLite + temp `DOWNLOADS_DIR` | Yes | Library, review, playlists, settings, download enqueue (yt-dlp stubbed), Range streaming |
| **Frontend unit** | Vitest (node) | Yes | Formatters, presets, catalog progress copy, URL helpers |
| **Frontend build** | `tsc -b && vite build` | Yes | Type errors and a broken production bundle |
| **Wiki** | `mkdocs build --strict` | Yes | Broken nav / missing Markdown pages |
| **Container** | `docker build` of the repo `Dockerfile` | Yes | The TrueNAS/Dockge artifact (frontend + wiki + Python image) |
| **Browser E2E / player** | Not in CI | No | Shaka, mini-player reparenting, Cast, iOS — still [manual](../reference/video-player-smoke.md) |
| **Live YouTube / Ollama** | Not in CI | No | Bot checks, cookies, GPU models — flaky and network-bound |

CI **must not** call YouTube, OpenRouter, or a real Ollama. Download tests stub `extract_preview`; AI enqueue is a no-op. That keeps the suite deterministic and under a minute for the Python/Node jobs.

!!! tip "Write a test when you fix a bug"
    If something broke in production (queue pause, device downloads, progress expiry, settings merge, update wiping host paths), add a pytest or Vitest case next to the fix. The existing files under `backend/tests/` and `frontend/src/**/*.test.ts` are the pattern.

## Local commands

Same commands GitHub Actions runs.

Backend (from `backend/`, venv with `requirements.txt` + `requirements-dev.txt`):

```bash
pip install -r requirements.txt -r requirements-dev.txt
pytest
```

Frontend:

```bash
cd frontend
npm ci   # or npm install
npm test
npm run build
```

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

Jobs (parallel): **backend** (pytest), **frontend** (Vitest + production build), **docs** (MkDocs `--strict`), **image** (`docker build` of the single-container app).

A red X on the commit or PR means “do not merge until it is green.” Open the failed job log; pytest and Vitest names map to files under `backend/tests/` and `frontend/src/`.

### After large changes

1. Push the branch (CI starts automatically).
2. Or, with no new commit, use **Run workflow** on the branch.
3. For player/CSS/Shaka work, also walk through the [video player smoke checklist](../reference/video-player-smoke.md) on your LAN.

### Optional: block merges until CI is green

On GitHub: **Settings → Branches → Add branch protection rule** for `main`.

- Require a pull request before merging (if you want that workflow)
- **Require status checks to pass**: `backend`, `frontend`, `docs`, `image`

Without protection, CI still **runs and reports**; it just will not physically stop a merge. For a homelab repo that is often enough if you glance at the checks.

## Adding coverage

Prefer **API tests** for anything the UI calls (`/api/videos`, playlists, settings, downloads). Use the `client` and `add_video` fixtures in `backend/tests/conftest.py` — they spin a FastAPI app with the real routers, a throwaway SQLite file, and **no** scanner/AI/catalog worker threads.

```python
def test_example(client, add_video):
    video = add_video(title="Clip", channel="Alpha")
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["title"] == "Clip"
```

Stub outbound work with `monkeypatch` (see `test_api_downloads.py` for `extract_preview`). Do not start uvicorn or Vite inside pytest.

Frontend: colocate `*.test.ts` next to the pure helper. Vitest is configured with `environment: "node"` — skip tests that need `window` / a real `<video>` unless you add a jsdom (or Playwright) job later.

## Related

- [Local development](local-dev.md)
- [Video player smoke checklist](../reference/video-player-smoke.md)
- [API overview](../architecture/api-overview.md)
- [Architecture overview](../architecture/overview.md)
