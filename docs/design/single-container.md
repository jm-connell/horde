# Single container

Horde is packaged as **one Docker image** that serves the API, the React SPA, and this MkDocs wiki from a single Uvicorn process. Operators mount volumes for media and data; they do not run a separate nginx or Node service in production.

## What the container serves

| Path | Content |
|------|---------|
| `/api/…` | FastAPI JSON API |
| `/docs`, `/redoc` | OpenAPI / Swagger (interactive API docs) |
| `/wiki/…` | Built MkDocs Material site (this documentation) |
| `/assets/…` | Vite-built frontend assets |
| `/*` | SPA `index.html` fallback for client routes |

The wiki mount is registered **before** the SPA catch-all so `/wiki/` is not swallowed by `index.html`.

Health reports `wiki_available` when the built wiki directory exists. In the UI, **Settings → System → Documentation** links to `/wiki/`.

## Multi-stage Dockerfile

The image is built in three stages:

1. **frontend** (`node:20-alpine`) — `npm install` + `npm run build` → static `dist/`
2. **docs** (`python:3.12-slim`) — `mkdocs build --strict` → HTML site
3. **runtime** (`python:3.12-slim`) — install Python deps + ffmpeg, copy `backend/app`, copy frontend build to `./static`, copy wiki to `./static/wiki`

The runtime entrypoint drops privileges with `PUID`/`PGID` (TrueNAS-friendly) and starts Uvicorn on port **8080**.

```text
frontend stage ──► /app/static
docs stage     ──► /app/static/wiki
backend source ──► /app/app
```

## Non-Docker / local development

For day-to-day coding you typically run Vite and Uvicorn separately (see [Local development](../getting-started/local-dev.md)). The repo can also keep a committed or copied `backend/static` tree so a plain backend process can serve a prebuilt UI without Docker — useful for quick checks and for environments that run the Python app directly.

!!! note "Strict docs build"
    The docs stage uses `mkdocs build --strict`. Broken links or nav entries fail the image build, which keeps the in-app wiki honest.

## Why one container

- Matches the [single-admin](no-auth.md) / one-homelab-box mental model
- Dockge / Compose stacks stay short: one service, two volumes (`/downloads`, `/app/data`)
- No version skew between “API image” and “UI image”
- Wiki and app ship together — docs match the build you are running

Tradeoff: scaling the API independently of the UI is not a goal. Neither is multi-replica SQLite.

## Related

- [Install with Docker](../getting-started/install-docker.md)
- [Updating](../getting-started/updating.md)
- [Ports & networking](../ops/ports-networking.md)
- [Architecture overview](../architecture/overview.md)
