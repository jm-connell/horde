# No authentication

Horde is a **single-admin** app with **no login, no users, and no roles**. Anyone who can reach the URL can download, delete, change settings, and spend OpenRouter budget if a key is configured.

!!! danger "Trusted LAN only"
    Do **not** publish Horde to the public internet. Do not reverse-proxy it without your own access control in front (VPN, SSO gateway, IP allowlist, etc.). Treat the bind address like a file share: only machines you trust should see it.

## Why no auth

The target deploy is a homelab on TrueNAS / Dockge (or any Docker host) where:

- One person (or household) administers the archive
- The server sits on a private network or VPN
- Adding accounts, password resets, and session cookies would complicate a [single-container](single-container.md) app without matching the threat model

Auth is deliberately out of scope for the core product. If you need multi-user isolation, put something else in front — or fork the app.

## Trusted LAN assumptions

| Assumption | Implication |
|------------|-------------|
| Network is trusted | API has no bearer tokens; browser cookies are unused for identity |
| Admin is the only operator | Settings, AI keys, and deletes are available to every client |
| Media paths are shared | SMB / NFS mounts of `/downloads` are part of the workflow |
| Chromecast / casting works | Receivers must fetch media cross-origin — see CORS below |

## CORS is intentionally wide for casting

Chromecast and similar receivers load media (and often subtitles) from the Horde host while the **sender** page lives on another origin. The FastAPI app enables CORS middleware so those receivers can `GET` / `HEAD` media with Range requests:

- `allow_origins=["*"]`
- Methods: `GET`, `HEAD`, `OPTIONS`
- Headers: `Range`, `Content-Type`
- Exposed: `Content-Range`, `Accept-Ranges`, `Content-Length`

That is convenient on a LAN and **unsafe** if the same port is reachable from the open internet: any site could instruct a browser (or a cast session) to pull your library URLs.

!!! warning "CORS is not authentication"
    Wide CORS does not replace a login page — it assumes there is nothing sensitive to gate. Combine it with LAN-only binding (or a VPN), not with “security through obscurity” on a public IP.

## Practical hardening (outside Horde)

If you must reach Horde remotely:

1. Prefer a **VPN** (Tailscale, WireGuard, etc.) into the LAN
2. Or put **HTTP basic auth / SSO** on a reverse proxy that only forwards after login
3. Keep OpenRouter API keys and Ollama on the private network; do not expose Ollama publicly either
4. Bind published ports to a LAN interface when your Docker host allows it

Copy-paste recipes: [Remote access](../ops/remote-access.md). See also [Ports & networking](../ops/ports-networking.md) and the [FAQ](../reference/faq.md).

## Related decisions

- [Why Horde](why-horde.md) — product intent
- [Single container](single-container.md) — one process serves UI + API + wiki
- [Settings split](settings-split.md) — where secrets like OpenRouter keys live (server `app_settings`, still unprotected by auth)
