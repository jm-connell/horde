# 0003. The auth model

Status: Accepted

## Context

Horde began as a no-login app for a trusted LAN ([history](../design/no-auth.md)). Sharing it with family showed the cost: one "continue watching" row, one theme, and anyone on the network able to delete the library. The goal is to separate people's history and preferences and to hold back destructive actions, **not** to become a multi-tenant service: the library stays shared, it is still one container with one SQLite file, and the network is still assumed to be trusted. Many homelab users also run an authenticating reverse proxy (Authelia, Authentik, Tailscale serve) and do not want a second login.

## Decision

- **Accounts.** The first account, created at first run by the setup wizard (`POST /api/auth/bootstrap`, which answers 409 once any user exists), is the administrator. The admin adds other people. There is no email, password-reset link, SSO or second factor; a lost admin password is reset on the host with `python -m app.cli reset-password`.
- **Server-side sessions.** Sign-in sets an opaque `horde_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS). Only the SHA-256 of the token is stored (`user_sessions`). A session lasts 30 days from last use. Resetting a password or disabling a user signs them out everywhere; a self-service password change keeps the current session and signs out the others. Sessions rather than JWTs because revocation must be immediate and there is a database anyway.
- **Passwords** are salted **scrypt** (`n=2^15, r=8, p=1`) from the standard library, stored as `scrypt$n$r$p$salt$hash` so the cost can be raised and old hashes re-hashed on login. Any non-empty password, no length or composition rules (the forms show a strength meter as advice; the owner decides). Sign-in is throttled per address and per username with exponential back-off (`429` with `Retry-After`); the limiter is an object on `app.state`.
- **Admin and member.** Admin-only routes declare `Depends(require_admin)` (users, server settings, AI provider configuration, factory reset, worker control, forced update check, backgrounds and fonts). Members get a fixed set of **grantable permissions** (`delete_videos`, `download`, `offline_download`, `edit_metadata`, `manage_playlists`, `use_ai`) checked with `Depends(require_permission(...))`. The permission names are stable API (stored in `users.permissions`); the table in `services/auth/permissions.py` is append-only. The server refuses any change that would leave no enabled administrator. An administrator cannot demote or disable their own account; another administrator has to.
- **Deny by default.** `AuthMiddleware` protects everything under `/api` (and `/docs`, `/redoc`, `/openapi.json`) except the exact `PUBLIC_ROUTES` list (`/api/ping`, `/api/ready`, `/api/health`, `/api/auth/state`, `/api/auth/login`, `/api/auth/bootstrap`). `tests/test_permissions.py` fails when a mutating route is neither gated (`GATES`: admin or a named permission) nor deliberately listed as open to any signed-in user (`OPEN_MUTATIONS`).
- **Per-user data is a short list**: watch position and history (`user_video_state`), UI preferences (`user_settings`) and AI chat (`video_ai_chat_messages.user_id`). Everything else is shared. Handlers take the caller from `Depends(current_user)`; a client-supplied user id is never trusted.
- **Signed media tokens.** Chromecast and AirPlay receivers send no cookies. `GET /api/videos/{id}/media-token` returns `<expiry>.<user id>.<hmac>`, an HMAC-SHA256 over video id, expiry, user id and an epoch derived from the user's password hash, keyed by `DATA_DIR/secret_key` (32 random bytes, mode 600, never in the database). It is valid 12 hours, only for GET/HEAD on that video's stream, subtitle and thumbnail routes, and dies when the password changes. Access logs redact `mt=`.
- **Trusted-proxy mode.** `HORDE_AUTH_DISABLED=1` turns the login off: every request acts as the first administrator, or, with `HORDE_TRUST_PROXY=1` and `HORDE_TRUSTED_USER_HEADER=<name>`, as the existing user named in that header (a missing or unknown name is refused, never falling back to admin). `HORDE_TRUST_PROXY` also makes Horde read the client address from `X-Forwarded-For`, counted from the right by `HORDE_TRUSTED_PROXY_HOPS`, because the left side is whatever the client claimed. With `HORDE_AUTH_DISABLED=1`, setting the header without trusting the proxy is a **startup error**, since Horde would otherwise ignore the header and make everyone an administrator. A warning is logged on every start while sign-in is disabled.

## Consequences

- Housemates get their own history and look; a member cannot delete the library unless granted; the admin can see and manage everyone. An account is a trust boundary for history and preferences, not a sandbox: members share and can see every video.
- Horde is still not hardened for the public internet. Sign-in is rate limited but there is no 2FA or recovery by email; the guidance remains VPN or an authenticating proxy.
- Every new route must be classified. A forgotten `require_admin` is caught by a test, not by review.
- `RequirePermission` in the SPA only hides controls; the server is the authority. Offline saves are the one exception where a permission can only hide buttons, because they read the same stream the player uses.
- Adding a permission means appending to the table and the docs, never renaming.
- `HORDE_AUTH_DISABLED` moves the whole trust decision to the proxy: if the port can be reached around it, every protection here is void. This is documented loudly and logged at startup.

Detail: [Accounts and sign-in](../ops/authentication.md), [Security model](../design/no-auth.md), [Security](../ops/security.md).
