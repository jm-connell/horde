# Ports & networking

## Default ports

| Where | Port | Role |
|-------|------|------|
| Container / uvicorn | **8080** | Horde API + static UI (+ wiki when built into the image) |
| Host (Compose) | **8686** | Published as `8686:8080` |
| Vite (local frontend) | **5173** | Dev-only React HMR; proxies API to the backend |

Bind address defaults to `0.0.0.0` (`HOST`). Change with [env vars](environment.md) if needed.

```text
Browser ──► host:8686 ──► container:8080 (FastAPI)
                │
                ├── /api/*          JSON + SSE + Range media
                ├── /assets/*       Frontend build
                ├── /wiki/          MkDocs (image builds only)
                └── /*              SPA (index.html)
```

## CORS (cast receivers)

Horde enables CORS with:

- **Origins:** `*`
- **Methods:** `GET`, `HEAD`, `OPTIONS`
- **Headers:** `Range`, `Content-Type`
- **Exposed:** `Content-Range`, `Accept-Ranges`, `Content-Length`

This exists so Chromecast / cast receivers can fetch media and subtitle URLs cross-origin from the sender page. It is not a general public API policy.

## LAN-only, no authentication

!!! danger "Do not expose to the internet"
    Horde has **no login, no API keys, no reverse-proxy auth of its own**. Anyone who can reach the port can download, delete, change settings, and read your library.

    Keep it on a trusted LAN, VPN, or a gateway that terminates auth. See [No authentication](../design/no-auth.md).

## Local development

Typical split:

| Process | URL |
|---------|-----|
| Backend (`uvicorn`) | `http://127.0.0.1:8080` |
| Frontend (`vite`) | `http://127.0.0.1:5173` |

The wiki is only present when MkDocs output is copied into the static tree (Docker image). Local API-only runs report `wiki_available: false` on `/api/health`. See [Troubleshooting](troubleshooting.md) and [Local development](../getting-started/local-dev.md).

## Related

- [Environment variables](environment.md)
- [API overview](../architecture/api-overview.md)
