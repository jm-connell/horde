# Security model

Horde is a self-hosted archive for one household or small group. Its security model is:

1. **Sign-in.** Every API route requires an account, except a short, explicit list ([accounts and sign-in](../ops/authentication.md#public-routes)). New routes are protected by default.
2. **One administrator, optional members.** The first account is the admin. Members share the library and get only the permissions the admin grants; server-wide settings, AI provider keys and user management are admin-only.
3. **Per-user history.** Watch progress, "continue watching", the history page, AI chats and the look of the app belong to the signed-in user. Library data (videos, tags, notes, playlists, AI summaries, downloads) is shared.
4. **Request-level hardening** that holds regardless of accounts: a Host allowlist (DNS rebinding), CSRF header, media-only CORS, size limits and URL validation. See [Security](../ops/security.md).
5. **A trusted network is the default.** Accounts keep housemates apart and stop casual access. Prefer a VPN ([Remote access](../ops/remote-access.md)). To publish Horde, follow the [internet exposure checklist](../ops/internet-exposure.md): TLS, a trusted proxy, an allowed host name, required two-step sign-in, strong passwords and updates, and read its list of remaining risks.

!!! danger "HORDE_AUTH_DISABLED is never for the internet"
    With sign-in disabled, anyone who can reach the port is an administrator. Do not combine it with a public port unless a proxy that you have tested authenticates everyone. There is also no email recovery.

## Why accounts

The original design assumed a single operator on a private network. Sharing a library with family showed the cost: one shared "continue watching" row and one shared theme. Accounts add exactly that, plus a way to hold back destructive actions, without turning Horde into a multi-tenant service: it is still [one container](single-container.md) with one SQLite file, and the library stays shared.

## What stays shared on purpose

| Shared | Per user |
|--------|----------|
| Videos, channels, tags, notes | Resume position and last watched time |
| Playlists | Continue watching and History |
| AI summaries, tags, chapters | AI chat conversations |
| Downloads and the queue | Appearance and layout preferences |
| Server settings (admin) | Password and sessions |

"For you" recommendations are seeded from the signed-in user's history; indexing and category sampling use the latest watch by anyone, because their output is shared.

## CORS is limited to the media routes

Chromecast and AirPlay receivers fetch media from the Horde host while the **sender** page lives on another origin, and they send no cookies. Only the video stream, subtitle and thumbnail routes send CORS headers, and a receiver is let in only with a short-lived signed `?mt=` token ([details](../ops/authentication.md#signed-media-urls)). Every other route sends no CORS headers, and every state-changing request needs an `X-Horde-Request` header, so a web page on another site cannot call the API.

## Related decisions

- [Accounts and sign-in](../ops/authentication.md) — how it works and how to recover
- [Why Horde](why-horde.md) — product intent
- [Single container](single-container.md) — one process serves UI + API + wiki
- [Settings split](settings-split.md) — server settings versus per-user preferences
