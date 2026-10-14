# Offline & installed app

Horde can be installed to your phone's home screen and used without a
connection: the app loads instantly from a local copy, and videos you
**Download** are stored inside Horde on that device, the same way the
YouTube app's downloads work.

!!! warning "Requires HTTPS"
    Browsers only allow the service worker and offline storage on **HTTPS**
    (or `localhost`). Opened as plain `http://192.168.x.x:8080`, Horde still
    works normally but the offline features are hidden and downloads fall
    back to saving files. See [Remote access](../ops/remote-access.md) for
    HTTPS options (Tailscale `serve`, Caddy).

## Install the app

- **iPhone / iPad (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** menu → **Install app** (or **Add to Home screen**).
- **Desktop Chrome / Edge:** the install icon in the address bar.

After the first visit, the UI (scripts, styles, icons) is cached by a service
worker. Later launches don't re-download it, even on a slow connection;
updates are fetched in the background and apply on the next launch.

## Downloading videos

| Where | How |
|-------|-----|
| Watch page (phone) | The **Download** button next to *Add to playlist* |
| Watch page (desktop) | **•••** → **Download for offline** |
| Library select mode | Select videos → **Download** |
| Download page | Destination **Offline (this device)** — Horde fetches the URL with yt-dlp, then the app saves it offline (not added to the library) |

Downloads run one at a time in the background while Horde is open. Video data
is fetched in 4 MB pieces, so a dropped connection resumes where it stopped
instead of starting over. Thumbnails, subtitles, chapters and SponsorBlock
segments are saved with the video. Scrub-preview sprites are not.

Manage everything on the **Offline** page (`/offline`, shown in the nav once
you have downloads; on phones also the download icon in the header): progress,
pause / resume, retry, remove, and how much storage is used.

The old behaviour — saving the raw file to the device's Downloads folder — is
still available as **•••** → **Save file to device**, **Save files** in
library select mode, and **Save file** on device download job cards.

!!! note "Storage"
    Horde asks the browser to keep downloads persistent, but the OS may still
    reclaim space when the device is very low on storage. iOS keeps far more
    for apps added to the Home Screen than for Safari tabs, so install the app
    if you plan to download a lot.

## Connection status

A tag next to the **HORDE** logo shows the connection state. It is hidden
while everything is fine.

| Tag | Meaning |
|-----|---------|
| **Connecting…** | Starting up or reconnecting. After 5 seconds a **Go offline** button appears. After 15 seconds without an answer Horde switches to offline mode by itself. |
| **Slow connection** · Go offline | The server answers, but slowly (pings over 2.5 s). Horde checks again whenever app requests are slow. |
| **Offline** | Offline mode. Tap it to try reconnecting now. |

In **offline mode**:

- Home shows only downloaded videos, and they play from local storage.
- Playlists, History, Download and Import are greyed out.
- Watch progress is saved locally and synced to the server when you're back.

If Horde went offline **by itself** (server unreachable), it keeps checking in
the background with a tiny `/api/ping` request (backing off from 3 s to once a
minute, paused while the app is hidden) and returns to normal automatically.
If **you** chose *Go offline*, it stays offline until you tap the tag.

Downloaded videos always play from local storage, even when online, which
saves bandwidth on a slow or metered connection.
