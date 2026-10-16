# Offline & installed app

Horde can be installed to your phone's home screen and used without a
connection: the app loads instantly from a local copy, and videos you
**Download** are stored inside Horde on that device, the same way the
YouTube app's downloads work.

!!! warning "Requires HTTPS"
    These features only work when Horde is opened at an **https://** address
    (or on `localhost`). Over plain `http://192.168.x.x:8686` Horde works
    normally, but downloads fall back to saving files and the app isn't
    cached. See [Setting up HTTPS](#https) below.

## Install the app

- **iPhone / iPad (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** menu → **Install app** (or **Add to Home screen**).
- **Desktop Chrome / Edge:** the install icon in the address bar.

After the first visit, the UI (scripts, styles, icons) is cached by a service
worker. Later launches don't re-download it, even on a slow connection;
new versions are fetched in the background but never swapped in under you:
an **Update available** notice with a **Reload** button appears, and the new
version starts when you press it (or the next time every Horde tab has been
closed). Tabs that were open before an update keep working until reloaded,
because the previous version's files are kept for one release. If you are
coming from a release older than this one, fully close the app (all tabs) once:
the old service worker has no update prompt.

## Downloading videos

| Where | How |
|-------|-----|
| Watch page (phone) | The **Download** button next to *Add to playlist* |
| Watch page (desktop) | **•••** → **Download for offline** |
| Library select mode | Select videos → **Download** |
| Download page | Destination **Offline (this device)** — Horde fetches the URL with yt-dlp, then the app saves it offline (not added to the library) |

Horde saves the file this device can actually play: the original when the device decodes it smoothly, otherwise the ≤1080p H.264 copy. If neither exists yet (an AV1 video on a device without AV1 decode), Horde starts creating the copy and asks you to save it again once it finishes. See [Playback compatibility](downloads.md#compatibility-codecs).

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

!!! note "Storage full"
    If the device runs out of space during a download, Horde removes the
    partial download, marks it as failed and shows how much storage is free.
    Remove other offline videos and retry.

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
- Watch progress is saved locally and synced to the server when you're back,
  to the account that was signed in while you watched. If someone else signs
  in on the device first, your positions wait for you (for up to 30 days)
  instead of landing in their history.
  If the signed-in account changes while positions are syncing (another tab
  signs in), the sync stops and carries on for the new account.
  A position the server refuses for good (the video was deleted) is dropped;
  one that hits a server error stays queued and is retried next time.

If Horde went offline **by itself** (server unreachable), it keeps checking in
the background with a tiny `/api/ping` request (backing off from 3 s to once a
minute, paused while the app is hidden) and returns to normal automatically.
If **you** chose *Go offline*, it stays offline until you tap the tag.

Downloaded videos always play from local storage, even when online, which
saves bandwidth on a slow or metered connection.

## Setting up HTTPS {#https}

### Why it's needed

Offline features are built on a browser feature called a **service
worker**: a small script the browser keeps on your device that can answer
the app's requests itself, from local storage, when the server is slow or
unreachable. Because a service worker can intercept everything a site
loads, browsers only allow one on **secure (https://) addresses**, so a
network attacker can't install a malicious one. Offline video storage has
the same rule.

`http://localhost` counts as secure, which is why it works on the machine
running Horde. A LAN address like `http://192.168.1.20:8686` or a plain
Tailscale IP does not. The certificate must also be **valid and trusted**:
a self-signed certificate the browser warns about isn't enough.

Horde itself doesn't need any changes. Put something that speaks HTTPS in
front of it.

### Option 1: Tailscale HTTPS (easiest, private)

If you already reach Horde over [Tailscale](../ops/remote-access.md#tailscale),
Tailscale can give it a real certificate on your private tailnet:

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns),
   open **DNS**, make sure **MagicDNS** is on, and click **Enable HTTPS**
   (under *HTTPS Certificates*).
2. On the machine running Tailscale that can reach Horde (usually the
   Docker / TrueNAS host), run:

    ```bash
    tailscale serve --bg 8686
    ```

    If Tailscale runs somewhere else on your LAN, point it at Horde's
    address instead: `tailscale serve --bg http://192.168.1.20:8686`.

3. Open the `https://<machine-name>.<tailnet-name>.ts.net` URL that the
   command prints. The first load can take a few seconds while the
   certificate is issued.
4. Install the app from that https URL (see [Install the app](#install-the-app)).
   An app installed from the old `http://` address won't get offline
   features, so remove it and re-add it from the https URL.

This stays private to your tailnet: nothing is exposed to the internet.

!!! tip "TrueNAS Tailscale app"
    If Tailscale runs as a TrueNAS app (in a container), run `tailscale serve`
    inside that app's shell, using Horde's LAN address as in step 2.

### Option 2: Reverse proxy with a certificate

Any reverse proxy with a trusted certificate works, for example
[Caddy](../ops/remote-access.md#caddy-basic-auth), Nginx Proxy Manager or
Traefik. Horde has its own sign-in, but if the hostname is reachable from the
internet, also put authentication on the proxy as the remote-access guide
describes.

### Check that it worked

Open Horde at the https address. The amber "offline videos & the
installable app are off" notice on Home should be gone, and a video's
**Download** button should start a download instead of explaining HTTPS.
