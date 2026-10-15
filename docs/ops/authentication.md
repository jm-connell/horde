# Accounts and sign-in

Horde asks everyone to sign in. There is one **administrator** (the first account), who adds the other people. Everyone shares the library, playlists, tags, notes and downloads; each person has their **own watch history, AI chats and look** (theme, layout, playback preferences).

## First run and upgrades

- **New install:** the first screen is *Create the admin account*, the first step of the setup wizard. Choose a username and a password of at least 8 characters.
- **Existing install (upgrading from a version without accounts):** the first visit after the upgrade shows the same screen. Creating the account is required, and it takes over what used to be the one shared profile:
    - the watch history and resume positions of every video,
    - your saved look and layout (the `ui` settings),
    - your AI chat history.

    Server settings (AI providers, download defaults, channel auto-download, ...) are unchanged.

Until that account exists nothing else can be done, so create it from a device you trust. Creating it is one-shot: once any account exists, `POST /api/auth/bootstrap` answers 409.

## Account types and permissions

When an administrator adds or edits an account they pick its **type** in *Settings → Users*:

- **Admin** can do everything, including managing users and server settings.
- **Member** can browse, search, watch, keep their own history, change their own password and appearance, and use the **permissions** they were given:

| Permission | Lets a member | Default |
|------------|---------------|---------|
| `delete_videos` | Delete videos and their files from the server, including bulk delete, and remove a video's H.264 playback copy | off |
| `download` | Queue downloads, import playlists, set up channel auto-download, import or upload files | on |
| `offline_download` | Save videos to the device for offline viewing, and fetch files from the server | on |
| `edit_metadata` | Edit titles, descriptions, notes, tags and thumbnails; rename channels | on |
| `manage_playlists` | Create, edit and delete the shared playlists | on |
| `use_ai` | AI chat and on-demand summaries, tags and chapters (these can cost money with a paid provider) | on |

These are **admin only** and cannot be granted: managing users, server-wide settings, AI provider configuration and worker control, factory reset, library-wide compatibility conversion, background and font management, pausing the download queue, a forced update check and the bulk metadata refresh.

Changes apply on the person's next request; they do not need to sign in again. The API answers a refused request with `403` and `code: "permission_denied"` (or `admin_required`); the app shows it as a message and hides the controls the account cannot use.

!!! note "Offline saves"
    The server can only enforce `offline_download` for the "download file" routes. Saving a video for offline playback in the installed app reads the same stream the player uses, so for that the permission only hides the buttons.

## Managing users (admins)

*Settings → Users* lists accounts. You can add a user (username, password, type and permissions), change a user's type and permissions, reset their password, disable or re-enable the account, and delete it. Resetting a password or disabling an account signs that person out everywhere. Deleting removes their history, chats and preferences; videos and playlists stay.

The server refuses any change that would leave **no enabled administrator**.

## Passwords and sessions

- Passwords are stored as salted **scrypt** hashes (`n=2^15, r=8, p=1`), never in clear. Minimum 8 characters, no composition rules, and not equal to the username.
- Signing in sets an `HttpOnly`, `SameSite=Lax` cookie `horde_session` (`Secure` over HTTPS). Only a hash of the token is stored. A session lasts 30 days from its last use.
- Changing your own password signs out your other browsers. Signing out deletes the session.
- After 5 failed sign-ins for a username from one address, further attempts wait with exponential back-off (`429` with `Retry-After`).

## Forgot the admin password

Run this on the Docker host; it reads the new password from the terminal (or from standard input when piped):

```bash
docker exec -it horde python -m app.cli reset-password <username>
docker exec -it horde python -m app.cli create-admin <username>
```

`reset-password` also re-enables a disabled account and signs the user out everywhere. `create-admin` adds another administrator.

## Public routes

Everything under `/api` (and `/docs`, `/redoc`, `/openapi.json`) requires a session. The exceptions:

| Route | Why |
|-------|-----|
| `GET /api/ping` | Connectivity probe for the installed app |
| `GET /api/health` | Readiness probe. Anonymous callers get only `status`, `setup_required` and `auth_required` |
| `GET /api/auth/state` | The app asks who is signed in |
| `POST /api/auth/login` | Sign in |
| `POST /api/auth/bootstrap` | Create the first admin; `409` once any account exists |
| the SPA files, `/wiki/*` | No data |
| stream, subtitle and thumbnail URLs with a valid `?mt=` token | Cast and AirPlay receivers send no cookie |

### Signed media URLs

`GET /api/videos/{id}/media-token` (signed in) returns `{token, expires_at}`: an HMAC over `video id | expiry | user id` with the key in `DATA_DIR/secret_key` (created on first start, mode 600, never stored in the database or returned by the API). It is valid for 12 hours, for that one video, on the stream, subtitle and thumbnail routes only, and stops working when that user's password is changed or reset. A malformed token is a plain `401`. The app only uses these URLs when handing media to a Chromecast or AirPlay receiver; the page's own player keeps using the cookie. Back up `secret_key` with the rest of `DATA_DIR`; if it is lost a new one is made and outstanding tokens stop working. A key file shorter than 32 bytes is never used or silently replaced: Horde reports it and the cast links fail until you delete the file.

## Behind a reverse proxy

| Variable | Effect |
|----------|--------|
| `HORDE_TRUST_PROXY=1` | Use `X-Forwarded-For` for the client address (rate limiting) and `X-Forwarded-Proto` for the `Secure` cookie flag. Set only when a proxy you control is the only way in. The proxy must **set or append** `X-Forwarded-For` and never pass a client-supplied value through unchanged: Horde reads the entry counted from the **right**, because everything to the left is whatever the client claimed. |
| `HORDE_TRUSTED_PROXY_HOPS=1` | How many proxies append to `X-Forwarded-For` (default 1 = the last entry). Raise it for a chain such as CDN, then proxy. |
| `HORDE_AUTH_DISABLED=1` | Turn sign-in off. Every request acts as the first administrator. **Only** for a deployment where a reverse proxy authenticates users and is the only route to the port. A warning is logged on every start. |
| `HORDE_TRUSTED_USER_HEADER=X-Remote-User` | With `HORDE_AUTH_DISABLED=1` **and** `HORDE_TRUST_PROXY=1`, act as the existing user named in this header (their history, permissions). A missing or unknown name is refused. Setting the header without `HORDE_TRUST_PROXY=1` is an error: Horde **refuses to start** rather than ignore the header and make everyone an administrator. |

!!! danger "HORDE_AUTH_DISABLED"
    With sign-in disabled, anyone who can reach the port is an administrator. If the proxy can be bypassed, so can every protection described on this page.

## What this does not do

Horde has no email, password-reset links, single sign-on or two-factor authentication, and an account is a trust boundary for *history and preferences* more than a sandbox: members share the library and can see every video. The [security model](../design/no-auth.md) and [Security](security.md) cover the rest.
