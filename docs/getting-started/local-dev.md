# Local development

Run the FastAPI backend and Vite frontend on your machine for UI and API work. This path does not require Docker, though you can still use Compose for a production-like stack ([Install with Docker](install-docker.md)).

!!! warning "LAN only — no authentication"
    Even in dev, Horde has **no login**. Do not expose the Vite or uvicorn ports beyond a trusted network.

## Prerequisites

- Python 3 with `venv`
- Node.js and npm
- `curl` (Linux/macOS helper scripts wait on `/api/health`)

On Fedora, something like `sudo dnf install python3 nodejs npm curl` covers the basics.

## One-command start (recommended)

### Linux / macOS

From the repo root:

```bash
./start.sh
```

`start.sh` execs `scripts/dev.sh`, which:

1. Sets `DOWNLOADS_DIR` and `DATA_DIR` to `./downloads` and `./data` under the repo (creating them if needed)
2. Creates `.venv` if missing and installs `backend/requirements.txt` when needed
3. Runs `npm install` in `frontend/` when `node_modules` is missing
4. Starts **uvicorn** with `--reload` on port **8080**
5. Starts **Vite** (`npm run dev`, usually **5173**) once the backend health check passes

Open the Vite URL printed in the terminal (typically `http://localhost:5173`). Vite proxies `/api`, `/docs`, `/redoc`, `/openapi.json`, and `/wiki` to `http://127.0.0.1:8080`.

!!! tip "Wiki in local dev"
    The Documentation link in Settings appears only when `backend/static/wiki/` exists (`wiki_available` on `/api/health`). Docker builds that tree automatically. Locally:

    ```bash
    # from repo root, with mkdocs-material installed
    mkdocs build -d backend/static/wiki --strict
    ```

    Then open `/wiki/` through Vite (or `http://127.0.0.1:8080/wiki/` directly). Restart is not required for static files, but Vite needs a restart if you just changed `vite.config.ts` proxies.

### Windows

```bat
dev.bat
```

That launches `scripts/dev.ps1`, which mirrors the same flow (repo-local `downloads` / `data`, uvicorn on `8080`, then `npm run dev`).

!!! tip "Proxy target is 127.0.0.1"
    The Vite config proxies `/api` to **`127.0.0.1:8080`**, not `localhost`. On Windows, `localhost` often resolves to IPv6 `::1` while uvicorn binds IPv4, which shows up as instant proxy 500s. Prefer the helper scripts so both sides stay aligned.

## Manual start (two terminals)

Backend:

```bash
cd backend
python3 -m venv ../.venv
source ../.venv/bin/activate   # Windows: ..\.venv\Scripts\activate
pip install -r requirements.txt
DOWNLOADS_DIR=../downloads DATA_DIR=../data uvicorn app.main:app --reload --port 8080
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Start the backend before the frontend so the proxy has something to talk to.

| Process | Default URL |
|---------|-------------|
| Backend (uvicorn) | `http://127.0.0.1:8080` |
| Frontend (Vite) | `http://localhost:5173` |
| API via Vite | `/api` → `127.0.0.1:8080` |
| Wiki / Swagger via Vite | `/wiki`, `/docs` → same backend |
| Swagger | `http://127.0.0.1:8080/docs` |

## Data directories in dev

| Env | Default under repo | Role |
|-----|--------------------|------|
| `DOWNLOADS_DIR` | `./downloads` | Media tree (`Channel/Year/Title [id].ext`) |
| `DATA_DIR` | `./data` | SQLite DB, thumbnails, sprites |

Scanner import extensions: **`.mp4`**, **`.mkv`**, **`.webm`**. Fallback poll interval: **`SCAN_INTERVAL_SEC`** (default **60**), same as Docker.

## Tests

Backend (from `backend/`, with the repo venv activated):

```bash
pip install -r requirements.txt -r requirements-dev.txt
PYTHONPATH=. pytest
```

Frontend:

```bash
cd frontend
npm install
npm test
```

CI runs the same suites (plus `npm run build`) on pull requests via `.github/workflows/ci.yml`.

## Sync frontend into the backend static tree

Production Docker serves a built SPA from the backend. After frontend changes you want baked into a container image (or a static-only run):

```bash
cd frontend
npm run build:sync
```

That runs `npm run build` then copies `frontend/dist` into `backend/static` via `scripts/sync-static.mjs`.

## Optional: Docker-shaped local stack

You can still use Compose on a laptop:

```bash
cp .env.example .env
# point DOWNLOADS_PATH / DATA_PATH at local dirs; set PUID/PGID
docker compose up --build -d
```

UI: `http://127.0.0.1:8686` (host **8686** → container **8080**). `bgutil-pot` starts automatically; Ollama needs `docker compose --profile ai up -d`.

## Related docs

- [First run](first-run.md) — smoke-test downloads and library
- [Environment variables](../ops/environment.md)
- [Settings](../settings/index.md)
- [Architecture overview](../architecture/overview.md)
