# Accounts and sign-in

Horde asks everyone to sign in. There is one **administrator** (the first account), who adds the other people. Everyone shares the library, tags, notes and downloads, and the playlists marked *App-wide*; each person has their **own watch history, AI chats, private playlists and look** (theme, layout, playback preferences).

## First run and upgrades

- **New install:** the first screen is *Create the admin account*, the first step of the setup wizard. Choose a username and a password of at least 8 characters.
- **Existing install (upgrading from a version without accounts):** the first visit after the upgrade shows the same screen. Creating the account is required, and it takes over what used to be the one shared profile:
    - the watch history and resume positions of every video,
    - your saved look and layout (the `ui` settings),
    - your AI chat history.

    Server settings (AI providers, download defaults, channel auto-download, ...) are unchanged.

Until that account exists nothing else can be done, so create it from a device you trust. Creating it is one-shot: once any account exists, `POST /api/auth/bootstrap` answers 409.

## Account types and permissions

When an administrator adds or edits an account they pick its **type** in *Account settings → Users*:

- **Admin** can do everything, including managing users and server settings.
- **Member** can browse, search, watch, keep their own history, change their own password and appearance, and use the **permissions** they were given:

| Permission | Lets a member | Default |
|------------|---------------|---------|
| `delete_videos` | Delete videos and their files from the server, including bulk delete, remove a video's H.264 playback copy, and list, restore and erase the [trash](../guides/library.md#trash) | off |
| `download` | Queue downloads, import playlists, set up channel auto-download (a channel's automatic download rule), import or upload files | on |
| `offline_download` | Save videos to the device for offline viewing, and fetch files from the server | on |
| `edit_metadata` | Edit titles, descriptions, notes, tags and thumbnails; rename channels | on |
| `manage_playlists` | Create App-wide playlists, make a playlist of their own App-wide, and edit or delete the App-wide playlists other people made. Every member can make private playlists and manage their own without it | on |
| `use_ai` | AI chat, on-demand summaries, tags and chapters, and the embedding half of library and channel-catalog search (these can cost money with a paid provider) | on |

Members do not see how the server is set up: the server settings, AI status and health endpoints answer them with readiness and feature switches only (no provider type or address, schedule, GPU details, API key tail, budget or model names), and the AI job list is for administrators. The same goes for the rest of the API: a member gets coarse status (counts, `ready`/`error` states, whether a GPU can encode) but no internal address, file path, model name, GPU name or raw error text. Where a member's screen reports a failure (a video whose AI indexing or H.264 copy failed) it gets a generic message; the administrator sees the server's own text. In detail, for a member:

- video reads give `embed_error` as "AI indexing failed" and `compat.error` as a generic sentence, and leave out `ai_summary_model` and `ai_summary_cost`;
- `GET /api/system/activity` lists tasks without `engine`, `detail` or `error`;
- `GET /api/settings` leaves the server-only fields at their defaults, including the library size limit (`max_library_bytes`);
- `GET /api/system/stats` leaves out the GPU name and memory and the ffmpeg path;
- `GET /api/health` leaves out the PO token provider address and error, and the message, target and URL of the last failed YouTube extract; its `storage_warning` says that storage is on a network filesystem without the data directory or mount point;
- `GET /api/channels/catalog/status` gives a failed catalog's `last_error` as "Indexing failed";
- a channel feed that cannot load answers with the generic message and code `channel_feed_unavailable` (for everyone; the server log has the cause).

Download job errors are not trimmed: they explain why a download the member can see failed (for example a private or members-only video).

These are **admin only** and cannot be granted: managing users, server-wide settings, AI provider configuration and worker control, factory reset, library-wide compatibility conversion, background and font management, pausing the download queue, a forced update check, starting an update (the **Update now** button) and the bulk metadata refresh. (Channel auto-download is *not* in this list: it needs only `download`.)

### What members can and can't change

Every administrator sees and can change everything below. A member sees only the first column; the rest is hidden from them in the app and refused by the API (403 `admin_required` or `permission_denied`).

| Area | A member can change | Needs a permission | Administrators only |
|------|---------------------|--------------------|---------------------|
| Settings → Appearance | Theme, saved themes, font (including Google Fonts by URL), font size, interface, background animation and picking an uploaded background image, custom CSS | | Uploading or deleting background images and font files, extracting a palette from a background |
| Settings → Library | Continue watching, progress bars, card dates, default sort, channel list order | Download count badge, normalize volume on download (`download`) | Progress expiry, playback compatibility (download codec, H.264 copy size, library copies and conversion), metadata and catalog (indexing, YouTube search switches, catalog size, refresh interval, resync) |
| Settings → Playback | Everything: watch page, previews, subtitles, SponsorBlock, speeds, offline mode | | |
| Settings → AI, System, Users | | | The whole tab: AI providers, keys, models, budget, schedule and jobs; storage, background activity, health, updates (checking for and starting one), factory reset; user management |
| Elsewhere | Their own password, history and chats | Downloads, imports, channel auto-download (`download`); saving for offline (`offline_download`); notes, details, thumbnails (`edit_metadata`); App-wide playlists (`manage_playlists`); AI chat and on-demand AI (`use_ai`); deleting (`delete_videos`) | Pausing or resuming the whole download queue, the bulk metadata resync, refreshing the AI category shelves |

Members still get the read-only values their screens need: the YouTube search switches, the progress expiry and the server's download codec (their downloads use it). `GET /api/settings` gives a member the defaults of the other server-only fields, and the library-wide compatibility totals (`GET /api/compat/summary`) and the metadata resync progress (`GET /api/videos/refresh-metadata/status`) are for administrators.

Every administrator is a full administrator: a second admin sees and may change everything the first one can. The only first-admin step is the one-time adoption of the data from before accounts existed (watch history, look and layout, AI chats), which goes to the account created first.

Changes apply on the person's next request; they do not need to sign in again. An open page picks up a new account type or permissions when it comes back to the front or when the server refuses one of its requests (a reload always does), and then reloads what it shows, so a newly promoted admin never edits the trimmed member copy of the settings. The API answers a refused request with `403` and `code: "permission_denied"` (or `admin_required`); the app shows it as a message and hides the controls the account cannot use.

!!! note "Offline saves"
    The server can only enforce `offline_download` for the "download file" routes. Saving a video for offline playback in the installed app reads the same stream the player uses, so for that the permission only hides the buttons.

## Your account

Click your name or picture at the top right: the menu has **Account settings** and **Sign out**. *Account settings* (`/account`) is where everyone sets a **profile picture** (any image, cropped to a 256 px square JPEG and kept in `DATA_DIR/avatars/`; other signed-in users see it next to your name) and **changes their password**, which signs out your other browsers. The old link `/settings?tab=users` opens this page.

Under **Downloads on shared devices** you choose whether other accounts on a device may see the videos you save there for offline viewing (*share*, on by default). Turning it off asks for your password: it is checked on the server like the change-password form (same throttle), and if this browser already holds downloads of yours it keeps a check value so you can unlock them with no connection (otherwise it asks when you save the first one, and confirms the password with `POST /api/auth/verify-password`, which answers `204` or `400 wrong_password` under the same throttle and changes nothing). `PATCH /api/auth/me` sets it (`{share_downloads, current_password}`; the password is required to turn it off, `400 password_required` / `wrong_password`). See [Sharing downloads between accounts](../guides/offline.md#sharing).

## Managing users (admins)

For administrators, *Account settings* also lists every account under **Users**. **Add a user** opens the form for a new account (username, password, type, permissions and whether their offline downloads are shared with other accounts on a device). You can also change a user's type and permissions, reset their password, disable or re-enable the account, and delete it. Resetting a password or disabling an account signs that person out everywhere: open pages lose access at once, and live event streams (download progress, AI chat replies) end within about 15 seconds. Deleting removes their history, chats, preferences and private playlists; videos stay, and their App-wide playlists are handed to the administrator who deletes the account. You cannot change your own account type or disable your own account (the API answers `409` with `code: "self_lockout"`): another administrator has to do it, so a lone administrator can never lock themselves out.

The server refuses any change that would leave **no enabled administrator** (`code: "last_admin"`).

## Passwords and sessions

- Passwords are stored as salted **scrypt** hashes (`n=2^15, r=8, p=1`), never in clear. Minimum 8 characters, no composition rules, and not equal to the username.
- Signing in sets an `HttpOnly`, `SameSite=Lax` cookie `horde_session` (`Secure` over HTTPS). Only a hash of the token is stored. A session lasts 30 days from its last use.
- Changing your own password signs out your other browsers. Signing out deletes the session.
- **Signed-in devices.** *Account settings → Signed-in devices* lists your browsers (a device label such as "Safari on iPhone", its address, when it was last active and when it signed in; sessions that have expired are not listed). **Sign out** ends one, and **Sign out all other devices** keeps only the one you are using. Ending a session takes effect on that browser's next request, and its open event streams end within about 15 seconds, the same as after a password reset. The device label is read from the browser's `User-Agent`, so an installed app looks like its browser. Administrators see the same list for any user (*Users → Edit → Signed-in devices*) and can end one session or **Sign out everywhere**. API: `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{id}`, `POST /api/auth/sessions/revoke-others`, and for administrators `GET /api/users/{id}/sessions`, `DELETE /api/users/{id}/sessions` and `DELETE /api/users/{id}/sessions/{session_id}`. The last-seen time is updated at most every five minutes, so "Active" can lag by that much. Signing a device out does not cancel the signed media links (`?mt=`, see below) already handed to a cast receiver: they keep working for up to 12 hours, for that one video. Change your password to end them too.
- After 5 failed sign-ins for a username from one address, further attempts from that address wait with exponential back-off (`429` with `Retry-After`). Separately, once a username has more than 5 failures in a minute from anywhere, every further attempt on that name waits one second: guessing across many addresses is capped, but nobody can lock a user out for longer than that from a different address. While such an attack is actually running, the real user can still be slowed down (attacker requests take most of the one-second slots); it clears within a second of the attack stopping. On top of that is a **daily ceiling**: once a username has had 50 failures within 24 hours (from any addresses), it accepts one attempt per ten seconds, from anywhere, until the oldest of those failures is a day old. That makes guessing across many addresses very slow without a lockout an attacker could use against you; a successful sign-in does not clear it, and while an attack runs your own attempts compete with the attacker's for those slots (a browser that is already signed in is unaffected, and `reset-password` on the server always works). A wrong second-step code counts as a failed sign-in everywhere above. Guessing the current password in *Account settings → Change password* uses the same throttle.

    Four more rules sit on top, all in memory (a restart forgets them):

    - **Tries are reserved before they are judged.** A guess takes one of the address's free tries *before* its password is hashed, and gives it back only when judged, so a burst of simultaneous guesses cannot all get past a check made before any of them finished: with 5 free tries, 80 simultaneous wrong passwords get exactly 5 judged and 75 answers of `429` without any hashing. At most 5 tries on one name are in flight at once. Password hashing (about 100 ms and 32 MiB each) is also capped to the number of CPUs; when every slot is taken a request waits a quarter of a second and is then answered `503` `busy` with `Retry-After: 1`, so a flood cannot starve the rest of the server.
    - **IPv6 clients count per /64.** One subscriber normally holds a whole /64 and can rotate through it, so all addresses in it share one back-off. An IPv4-mapped IPv6 address counts as the IPv4 address.
    - **A known browser is spared the name-wide slowdown.** A complete sign-in (second step included) sets a signed, `HttpOnly`, `SameSite=Lax` cookie `horde_device` for a year, tied to the account and its password. A sign-in attempt that presents a valid one for the account it names skips the per-minute slowdown and the daily ceiling of that name (so a stranger hammering your username does not shut your usual browser out), but it keeps its own per-device and per-address back-off, and the password or code is still required. Changing the password retires the cookie. Another account's cookie does nothing for this one.
    - **Wrong codes escalate per account.** Every ten wrong second-step codes (authenticator or recovery) against one account make its code step wait twice as long: 30 seconds, then 1 minute, 2, 4 ... up to one hour. A right password does not reset this, a known browser is not exempt from it, and only a right code or a day without failures clears it. See [Remaining risks](internet-exposure.md#risks).

    The failure alert is described in [Internet exposure](internet-exposure.md#alerts). Behind a reverse proxy set `HORDE_TRUST_PROXY=1`, otherwise every client looks like one address and shares one back-off.

## Confirming your password for sensitive actions {#reauth}

A browser that signed in is trusted with your history and preferences, but a stolen session cookie must not be enough to *keep* the account. So an administrator is asked for the password again (and a code, with two-step sign-in) before:

- adding a user, or making an account an administrator;
- setting another account's password, deleting an account, resetting another account's two-step sign-in, or signing another account out everywhere;
- changing *Require two-step sign-in*.

Signing in counts, and so does confirming: the next ten minutes need nothing more. The app shows a *Confirm your password* dialog when the server answers `403` with `code: "reauth_required"` and repeats the request once you confirm (`POST /api/auth/reauth {password, code}`, `204`, under the same throttle as the other password checks). Everything else an administrator does (permissions, disabling an account, settings other than the requirement) needs nothing extra. Sessions that existed before an upgrade ask once. With `HORDE_AUTH_DISABLED=1` nothing is asked (the proxy signs people in).

Setting your **own** password is not an administrator action: `PATCH /api/users/{id}` refuses it for your own account (`400`, `code: "use_change_password"`), because *Change password* asks for the current password and a thief with only the cookie does not have it.

## Two-step sign-in {#two-step-sign-in}

An account can ask for a code from an authenticator app (1Password, Aegis, Google Authenticator, Authy, ...) in addition to the password. It is optional unless an administrator [requires it](#requiring-two-step-sign-in). Standard TOTP (RFC 6238: SHA-1, 6 digits, 30 seconds), computed with the Python standard library.

**Set up** in *Account settings → Two-step sign-in*: enter your password, scan the QR code (drawn on the server, so the secret never goes to a QR service) or type the key into the app, and enter the first code. Then Horde shows **ten recovery codes**, once: copy them or download a `.txt` and keep them somewhere safe and apart from the phone. Each recovery code works once, in place of an app code; Horde keeps only a keyed hash of each. Turning it on signs out your other browsers, because they signed in without a second step.

**Signing in** then takes two steps. A correct password answers `401` with `code: "totp_required"` and a ticket (`extra.pending_token`); the sign-in page asks for the code, or **Use a recovery code**, and sends `POST /api/auth/login/totp {pending_token, code}`, which starts the session. The ticket lasts five minutes, works once, is signed with the app's `secret_key` and is tied to the account's current password and second-factor state, so changing the password or turning two-step sign-in off or on voids it. Five wrong codes burn a ticket. A code is accepted for its own 30 second step and the one on either side (clock drift), and **a step that has been used is never accepted again**, so a code someone watched you type is useless. Wrong codes are counted in the [same throttle](#passwords-and-sessions) as wrong passwords, and a right password does not clear them.

**Lost phone.** Use a recovery code, then set up again (*Turn off*, then *Set up*). With no code left, an administrator resets it in *Users → Edit → Reset two-step sign-in* (this signs the person out everywhere; the password alone works again). The administrator can run the same on the server:

```bash
docker exec -it horde python -m app.cli reset-2fa <username>
```

**Turning it off**, or making new recovery codes, needs your current password *and* a code (an app code or an unused recovery code), under the same throttle. Setting it up also needs your password, so a stolen session cannot attach an authenticator of its own. An administrator cannot reset their own account from *Users*; they use *Turn off*.

**Forgot password** does not bypass it: after a reset with the log code the password is new, but the sign-in still asks for the code (the reset answers `401 totp_required` with a ticket, and the page continues to the code step). Having the server log proves the password may change, not who is typing.

The secret is stored as it is in the database (`users.totp_secret`), like the session hashes and the signing key, because it must be readable to check a code: **protect `DATA_DIR` and its backups**. It is never returned by the API after setup.

API (all need a session; `setup` and `confirm` responses are `Cache-Control: no-store`): `GET /api/auth/2fa` (status, recovery codes left), `POST /api/auth/2fa/setup {current_password}` (secret, `otpauth://` link, QR as SVG), `POST /api/auth/2fa/confirm {code}` (recovery codes), `POST /api/auth/2fa/disable {current_password, code}`, `POST /api/auth/2fa/recovery-codes {current_password, code}`; for administrators `DELETE /api/users/{id}/two-factor`. With `HORDE_AUTH_DISABLED=1` they answer `400 auth_disabled`.

### Requiring two-step sign-in {#requiring-two-step-sign-in}

*Settings → System → Security → Require two-step sign-in* (`require_two_factor` in `/api/settings`, administrators only) is **Optional**, **Administrators** or **Everyone**. An account that must use it but has not set it up is taken to the setup screen right after signing in and can do nothing else: the server answers every route except `GET /api/auth/state`, sign-out and the setup routes with `403` and `code: "two_factor_enrollment_required"` (including signed cast links). That applies to the administrator who changes the setting, too, at their next request. If the settings file becomes unreadable the last value Horde read stays in force until it can be read again; a damaged file's stand-in defaults are never taken for the requirement. With `HORDE_AUTH_DISABLED=1` nothing is required (the proxy signs people in).

## Forgot your password

Click **Forgot password?** on the sign-in page and enter your username. Horde writes a one-time **reset code** to its server log, which whoever runs Horde can read:

```bash
docker logs horde 2>&1 | grep "PASSWORD RESET CODE"
```

(On TrueNAS, the app's log view shows the same line.) Enter the code with a new password on the same page: you are signed in, and every other browser of that account is signed out. A code works once and expires after 15 minutes; it is tied to the account and its current password, so it stops working once the password changes some other way or the account is signed into normally. Asking again writes a new code at most every 30 seconds, and the three newest stay valid, so use the newest line. Five wrong codes in a row cancel the account's pending codes. Anyone on the network can ask for a code or burn one with wrong guesses (they never see it), so a determined prankster can keep you from finishing; the command below always works. Nothing is logged for a username that does not exist or is disabled, and the page answers the same either way. Why it works this way: [ADR 0012](../adr/0012-password-reset-through-the-server-log.md). An administrator can also reset a member's password in *Account settings → Users*.

### Without the log

If you cannot read the log (or set `HORDE_LOG_LEVEL=ERROR`, which hides the code), run this on the Docker host instead; it reads the new password from the terminal (or from standard input when piped):

```bash
docker exec -it horde python -m app.cli reset-password <username>
docker exec -it horde python -m app.cli create-admin <username>
```

`reset-password` also re-enables a disabled account and signs the user out everywhere. `create-admin` adds another administrator. `reset-2fa` turns off an account's [two-step sign-in](#two-step-sign-in) and signs it out everywhere; `reset-password` leaves two-step sign-in as it is.

## Public routes

Everything under `/api` (and `/docs`, `/redoc`, `/openapi.json`) requires a session. The exceptions:

| Route | Why |
|-------|-----|
| `GET /api/ping` | Connectivity probe for the installed app |
| `GET /api/ready` | Readiness probe: database, migrations and worker health (see [Monitoring](monitoring.md#ready)) |
| `GET /api/health` | Health summary. Anonymous callers get only `status`, `setup_required` and `auth_required` |
| `GET /api/auth/state` | The app asks who is signed in |
| `POST /api/auth/login` | Sign in (first step) |
| `POST /api/auth/login/totp` | Second step of a two-step sign-in: needs a signed ticket from the first |
| `POST /api/auth/bootstrap` | Create the first admin; `409` once any account exists |
| `POST /api/auth/forgot` | Write a one-time reset code to the server log; always `204` |
| `POST /api/auth/reset` | New password with that code; signs in (or continues to the second step) |

`POST /api/auth/reauth` needs a session (it is how a signed-in browser confirms its password, see [above](#reauth)).
| the SPA files, `/wiki/*` | No data |
| stream, subtitle and thumbnail URLs with a valid `?mt=` token | Cast and AirPlay receivers send no cookie |

!!! note "Device downloads follow the owner's sharing setting"
    A download whose destination is *this device* (not the library) is recorded with the account that queued it (`download_requesters`). It is visible to that account, to administrators, and, while that account's *share downloads* setting is on (the default), to everyone else. Otherwise `GET /api/downloads/{id}`, `/{id}/file`, `/{id}/events`, `DELETE /api/downloads/{id}` and the queue list treat it as nonexistent (`404` / left out), and *Dismiss finished* skips it. Jobs nobody queued (automatic ones) and library jobs are unaffected. Device files are ephemeral (deleted when dismissed), and this is privacy between household accounts, not secrecy from an administrator.

### Signed media URLs

`GET /api/videos/{id}/media-token` (signed in) returns `{token, expires_at}`: an HMAC over `video id | expiry | user id` with the key in `DATA_DIR/secret_key` (created on first start, mode 600, never stored in the database or returned by the API). It is valid for 12 hours, for that one video, on the stream, subtitle and thumbnail routes only, and stops working when that user's password is changed or reset. A malformed token is a plain `401`. The app only uses these URLs when handing media to a Chromecast or AirPlay receiver; the page's own player keeps using the cookie. Access logs redact the `mt=` value. Back up `secret_key` with the rest of `DATA_DIR`; if it is lost a new one is made and outstanding tokens stop working. A key file shorter than 32 bytes is never used or silently replaced: Horde reports it and the cast links fail until you delete the file.

## Behind a reverse proxy

| Variable | Effect |
|----------|--------|
| `HORDE_TRUST_PROXY=1` | Use `X-Forwarded-For` for the client address (rate limiting) and `X-Forwarded-Proto` for the `Secure` cookie flag and the `Strict-Transport-Security` header. Set only when a proxy you control is the only way in. The proxy must **set or append** `X-Forwarded-For` and never pass a client-supplied value through unchanged: Horde reads the entry counted from the **right**, because everything to the left is whatever the client claimed. |
| `HORDE_TRUSTED_PROXY_HOPS=1` | How many proxies append to `X-Forwarded-For` (default 1 = the last entry). Raise it for a chain such as CDN, then proxy. |
| `HORDE_AUTH_DISABLED=1` | Turn sign-in off. Every request acts as the first administrator. That account can still manage every other user, but cannot demote or disable itself (it is the one acting); delete it if it must go. **Only** for a deployment where a reverse proxy authenticates users and is the only route to the port. A warning is logged on every start. |
| `HORDE_TRUSTED_USER_HEADER=X-Remote-User` | With `HORDE_AUTH_DISABLED=1` **and** `HORDE_TRUST_PROXY=1`, act as the existing user named in this header (their history, permissions). A missing or unknown name is refused. Setting the header without `HORDE_TRUST_PROXY=1` is an error: Horde **refuses to start** rather than ignore the header and make everyone an administrator. |

!!! danger "HORDE_AUTH_DISABLED"
    With sign-in disabled, anyone who can reach the port is an administrator. If the proxy can be bypassed, so can every protection described on this page.

## What this does not do

- **Two-step sign-in guards the sign-in, not a session that already exists.** A stolen `horde_session` cookie is a signed-in user until it is ended (*Signed-in devices*, or changing the password). The actions that would let a thief keep the account (adding or promoting a user, setting another account's password, changing the requirement, setting up an authenticator without the password) ask for the password again, see [above](#reauth); everything else a signed-in user can do, they can do.
- **A required-but-not-yet-enrolled account is trust on first use.** Until its owner enrolls, whoever signs in with the password first gets the setup screen and attaches their own authenticator. Have every account enroll before you publish the port.

- **Signing out does not clear offline copies.** Videos saved for offline viewing live in the browser's cache and IndexedDB, which belong to the browser profile, not the account. Each copy records who saved it, and an account that turned off *share downloads* keeps its copies out of other accounts' lists, but that is privacy in the app, not encryption: the files are readable to anyone with full access to the browser profile, and the saved check value of the owner's password (PBKDF2-SHA256, 600 000 iterations, used to unlock their downloads with no connection) could be attacked offline. That value exists only in browsers that hold downloads saved by the account: it is created when the account saves its first download there (or at a sign-in when they are already there), kept across sign-outs, and deleted with the last download. Anyone who can see a copy can remove it; only its owner can remove a private one. For real separation use a separate browser profile.
- **Watch progress saved offline stays with its account.** A position saved while the server was unreachable is queued in the browser together with the id of the account that was signed in. When the connection is back, Horde asks the server who is signed in now and sends only that account's positions; another account's wait in the queue until that person signs in on the device again, and anything older than 30 days is dropped. Positions queued by releases before this behaviour did not record an account and are discarded on upgrade rather than guessed. A queued position also records when it was reached, and the server keeps it only if that account has saved nothing newer since on another device.
- **Resume points of offline copies are per account too.** The saved video belongs to the device, but each account that plays it there has its own place in it. Online, it resumes where the server says that account is (the place reached on any device), unless this device holds a newer position it could not send yet; offline, it resumes where that account last was on this device, and an account that never played it there starts from the beginning. Copies saved by releases before this kept one position for the whole device; that position is dropped on upgrade rather than given to whoever opens the video next.

Horde has no email, password-reset links or single sign-on (two-step sign-in is optional and covered above), and an account is a trust boundary for *history and preferences* more than a sandbox: members share the library and can see every video. The [security model](../design/no-auth.md), [Security](security.md) and, for reaching Horde from outside, the [internet exposure checklist](internet-exposure.md) cover the rest.
