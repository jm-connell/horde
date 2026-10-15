# WP-G: Authentication and per-user history

Owner's requirement, verbatim: "add authentication. Nothing crazy, just a username and password created on setup. First user is an admin, then they can add new users and enter their passwords. Each user has their own history but shares most other data, including the full library."

The architecture decisions below were made by the lead architect. Follow them; if one is clearly unworkable, pick the closest safe alternative and explain why in your report.

## Data model (Alembic revision `0003_auth`, on top of the current head; check `alembic heads`)
- `users`
  - Columns: id (autoincrement), username (unique, case-insensitive: store `username` as entered plus `username_norm` lowercased, unique), password_hash, is_admin (bool), created_at, updated_at, last_login_at, disabled (bool, default false).
- `user_sessions`
  - Columns: id, user_id FK→users ON DELETE CASCADE, token_hash (sha256 hex of the random token, unique, indexed), created_at, last_seen_at, expires_at, user_agent (truncated), ip (truncated).
- `user_video_state`
  - Columns: user_id FK CASCADE, video_id FK→videos CASCADE, position_sec float, last_watched_at, PRIMARY KEY (user_id, video_id), index (user_id, last_watched_at).
  - Data migration: when the first admin is created, copy each video's legacy `videos.last_position_sec` / `last_watched_at` into that admin's state. Do this inside the bootstrap code path (the users table is empty during the migration). After that, the legacy columns are no longer read or written by app code. Leave the columns in place in this revision (note them for a later cleanup).
- `user_settings`
  - Columns: user_id PK FK CASCADE, ui_json (text), updated_at. These are per-user UI preferences. Server-wide settings stay in app_settings.json.
  - On bootstrap, copy the existing global `ui` blob into the admin's row. New users start from the server-wide `ui` blob as their default.
- An app secret for signing media URLs: `DATA_DIR/secret_key` (32 random bytes, created on first start, chmod 600). Never put it in the DB or the API.

## Passwords
- `hashlib.scrypt` (n=2**15, r=8, p=1, dklen=64, 16-byte random salt). Stored as `scrypt$n$r$p$salt_b64$hash_b64`. Compare with `hmac.compare_digest`. Verify-and-rehash if the parameters change. No new dependency.
- Policy: minimum 8 characters. No composition rules. Reject passwords equal to the username.
- Login rate limiting: an in-process limiter object (created in lifespan and attached to `app.state`; no module globals) keyed on (ip, username_norm). Exponential backoff after 5 failures. Return 429 with Retry-After. Use a constant-time dummy hash check for unknown users.

## Sessions
- 32-byte urlsafe random token in an HttpOnly cookie `horde_session`. SameSite=Lax, Path=/, Secure when the request scheme is https (respect X-Forwarded-Proto only if `HORDE_TRUST_PROXY=1`).
- Sliding expiry: 30 days, `last_seen_at` refreshed at most once per 5 minutes.
- Logout deletes the row. A password change deletes all of the user's other sessions. Disabling or deleting a user kills their sessions.

## Enforcement
- An `AuthMiddleware` slotted into `backend/app/security.py`'s stack at the documented auth slot (after CSRF). Deny by default for `/api/*`, `/docs`, `/redoc` and `/openapi.json`.
- Public allowlist (exact):
  - `GET /api/ping`
  - `GET /api/health` (but the unauthenticated response is reduced to `{status, setup_required, auth_required}` with no internal URLs or counts; authenticated users get the full payload)
  - `GET /api/auth/state`
  - `POST /api/auth/login`
  - `POST /api/auth/bootstrap` (only while zero users exist; otherwise 409)
  - static SPA assets, `index.html`, `sw.js`, `manifest.json`, icons, `/wiki/*`
  - the signed-media routes below, when the signature is valid
- Unauthenticated API calls get 401 JSON `{"detail": "...", "code": "auth_required"}`.
- Expose the user on `request.state.user`. Add FastAPI dependencies `current_user` and `require_admin` (403 `code: admin_required`).
- Admin-only:
  - user management
  - factory reset
  - PATCH of server-wide settings (everything except the caller's own `ui` prefs)
  - AI provider config and test endpoints
  - compat convert-library / backfill / cancel
  - deleting videos with `delete_files=true` and bulk-delete
  - background/font upload and delete
  - channel autodownload config
  - update-check refresh
  - Anything else that mutates server-wide config: use judgement, and LIST every admin-only route in your report.
- Members can: browse, search, watch, edit video metadata (title, notes, tags), download/import, manage playlists (shared), use AI chat and summaries on demand, and change their own password and UI prefs.
- Signed media URLs for Chromecast and AirPlay receivers (they send no cookies):
  - `GET /api/videos/{id}/media-token` (authenticated) returns `{token, expires_at}`. The token is an HMAC-SHA256 over `video_id|expiry|user_id` with the secret key, valid 12h.
  - The stream, subtitles and thumbnail routes accept `?mt=<token>` in place of a cookie. The middleware validates the HMAC and expiry and that the video id matches the path.
  - The frontend uses tokenized URLs ONLY when handing URLs to a cast receiver or for AirPlay. The normal `<video>` src stays cookie-authenticated, so the offline SW cache keys don't change.
  - Read `frontend/src/components/VideoPlayer.tsx` (`startChromecast`), `useAirPlay.ts` and `useChromecast.ts` to wire this correctly.
- SSE and EventSource are same-origin, so cookies flow. Verify download events and AI chat streaming still work.
- Service worker: offline downloads fetch with credentials (same-origin default). Verify offline e2e still passes, and that a 401 is never cached.

## Per-user history semantics
- Watch progress (`PATCH`/`POST` progress endpoint), continue watching, history page, the `last_watched_at` sort, "watched" indicators, AI recommendations seeded from watch history: all read and write `user_video_state` for the current user.
- Serializers return the current user's position and last_watched_at in the existing fields (`last_position_sec`, `last_watched_at`), so the frontend contract is unchanged.
- Library list queries that filter or sort by watch state join `user_video_state` on the current user (outer join).
- Background workers that look at "recently watched" (AI worker recommendations) use the max over users, or are explicitly per-user if they produce per-user output. Decide and document.
- Shared: library, channels, playlists, tags, notes, AI summaries/tags/chapters, downloads and the download queue, imports. AI chat history stays shared per video in this package (note it as an owner question).
- `user_settings.ui`: GET /api/settings merges the caller's ui prefs over the server defaults. PATCH with only `ui` writes the caller's prefs (any user). PATCH with anything else requires admin.

## Setup and UX (frontend)
- `GET /api/auth/state` returns `{users_exist, authenticated, user: {id, username, is_admin} | null, setup_completed}`.
- App boot flow in `App.tsx` / `useSetupGate`:
  - (1) No users exist → a "Create admin account" screen. This is the FIRST step of the existing setup wizard for new installs. For existing installs that already completed setup, it is a standalone screen that then returns to the app.
  - (2) Users exist but not authenticated → Login page (username, password, error states, rate-limit message).
  - (3) Authenticated → the app. The 401 handler in `api.ts` redirects to login, preserving `?next=`.
- Top nav: a user menu showing the username, with Change password and Sign out. For admins, also a Users link.
- Settings → Users (admin): list users; create a user (username + password + admin checkbox); reset a user's password; toggle admin; disable/enable; delete with ConfirmDialog. You can't delete or demote yourself if you're the last admin; the server enforces it too.
- Accessibility: labelled fields, focus management, `aria-live` errors; reuse the existing modal and focus-trap utilities if present.
- Recovery CLI: `python -m app.cli reset-password <username>` (prompts or reads stdin) and `python -m app.cli create-admin <username>`, runnable via `docker exec`. Document it in docs/ops.
- Optional env `HORDE_AUTH_DISABLED=1` for users who front Horde with an authenticating reverse proxy. It forces single-user mode as a synthetic admin, logs a WARNING on every boot, and is documented with a big caveat. Paired with an optional trusted header `HORDE_TRUSTED_USER_HEADER` (only honoured when `HORDE_TRUST_PROXY=1`), mapping to an existing username.

## Tests (prefer e2e + API level)
- API (TestClient):
  - bootstrap only when empty
  - login success, failure and rate limit
  - logout
  - session expiry and sliding refresh
  - every non-public route returns 401 when anonymous (iterate `app.routes` and assert; maintain an explicit allowlist in the test)
  - admin-only routes return 403 for members (iterate the list)
  - per-user progress isolation (user A's progress invisible to B)
  - legacy history migrated to the first admin
  - media token: valid, expired, wrong video id, tampered
  - password change kills other sessions
  - last-admin protection
  - CLI reset-password
- Update the conftest `client` fixture to log in as an admin by default (seeded user), plus fixtures `member_client` and `anon_client`. Existing tests must keep passing without weakening.
- e2e: `e2e_seed.py` seeds an admin (`admin` / known password) and a member. A Playwright global setup logs in and saves `storageState` for the app project. New specs:
  - first-run bootstrap creates the admin (setup project)
  - login/logout and a wrong password
  - the admin creates a member; the member logs in in a second browser context, sees the library, and has their own continue-watching row (the admin's history is not shown)
  - the member cannot see the Users settings
  - unauthenticated deep link → login → back to the deep link
- Run the WHOLE e2e suite with auth on.

## Docs
- New `docs/ops/authentication.md`.
- Update the "no-auth" page (it is now obsolete; rewrite it as the security model), README, .env.example, CLAUDE.md (auth conventions: new routes are protected by default; admin-only needs `require_admin`; never read `videos.last_position_sec`).
- CHANGELOG entry with upgrade notes: existing installs are prompted to create the admin account on first visit after upgrade, and their watch history moves to that admin.
