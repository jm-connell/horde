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

Only the video stream, subtitle and thumbnail routes send CORS headers (`Access-Control-Allow-Origin: *`, methods `GET`, `HEAD`, `OPTIONS`, `Range` allowed), so Chromecast can fetch them cross-origin. All other routes send none. Horde also only answers LAN-style `Host` names; behind a reverse proxy set `HORDE_ALLOWED_HOSTS`. See [Security](security.md).

## LAN-only

!!! danger "Do not expose to the internet"
    Horde has accounts ([details](authentication.md)) but no two-factor sign-in and no hardening against a determined remote attacker. Anyone who can reach the port can try passwords, and any signed-in user can read the library.

    Keep it on a trusted LAN, VPN, or a gateway that terminates auth. Recipes: [Remote access](remote-access.md). Design: [Security model](../design/no-auth.md).

## Local development

Typical split:

| Process | URL |
|---------|-----|
| Backend (`uvicorn`) | `http://127.0.0.1:8080` |
| Frontend (`vite`) | `http://127.0.0.1:5173` |

The wiki is only present when MkDocs output is copied into the static tree. Docker builds it into the image; `./start.sh` builds it locally by default. See [Troubleshooting](troubleshooting.md), [Local development](../getting-started/local-dev.md), and [Remote access](remote-access.md).

## Related

- [Environment variables](environment.md)
- [Remote access](remote-access.md)
- [API overview](../architecture/api-overview.md)
