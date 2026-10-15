# Security

Horde has [accounts](authentication.md) ([model](../design/no-auth.md)) and is meant for a network you trust. This page describes what Horde enforces so that a web page you visit, or a hostile DNS name, cannot use your signed-in browser to reach into that network. Sign-in is checked after these protections.

!!! danger "Still LAN only"
    None of this replaces access control. Do not publish the port to the internet. See [Remote access](remote-access.md).

## What Horde enforces

| Threat | Defence |
|--------|---------|
| A website you visit sends requests to `http://truenas:8686` (for example to wipe the library) | Every state-changing request must carry an `X-Horde-Request` header. Browsers force a CORS preflight for custom headers, and Horde never grants one. `Sec-Fetch-Site: cross-site` and a mismatching `Origin` are refused too (HTTP 403). The web app adds the header itself. |
| DNS rebinding: an attacker's domain re-points at your LAN address | Host allowlist (below). Other names get HTTP 400. |
| A page reads your library cross-origin | No CORS headers anywhere except the media routes below. |
| Links or thumbnails that make the server fetch internal URLs (SSRF) | [URL safety](#private-urls). |
| Stored XSS through links, custom CSS | Only `http(s)` links are stored and rendered; custom CSS cannot load remote resources; a Content-Security-Policy is sent. |
| Oversized or fake uploads | [Upload limits](#upload-limits). |
| Factory reset triggered by accident | The request must contain the typed phrase `RESET` (or `ERASE MEDIA` when erasing media). The UI asks for it. |

If you script the API yourself, send `X-Horde-Request: 1` on every `POST`, `PUT`, `PATCH` and `DELETE`.

## Allowed hosts { #allowed-hosts }

Horde answers requests whose `Host` header is one of:

- `localhost` and loopback addresses
- any IP address that is not publicly routable: private ranges, link-local, and the CGNAT range Tailscale uses (`100.64.0.0/10`)
- single-word names such as `truenas`
- names ending in `.local`, `.lan`, `.home.arpa`, `.internal` or `.ts.net`

Anything else, for example `horde.example.com` behind a reverse proxy, must be listed in `HORDE_ALLOWED_HOSTS` (comma separated, `*.example.com` matches subdomains). The list **adds** to the defaults, so `localhost` health checks keep working. `*` switches the check off.

```text
HORDE_ALLOWED_HOSTS=horde.example.com,*.corp.example
```

A rejected request gets HTTP 400 with a message naming `HORDE_ALLOWED_HOSTS`. If you reach Horde by a public IP address, add that IP to the list too.

Reverse proxies should pass the original `Host` (Caddy and nginx `proxy_set_header Host $host` do) or set `X-Forwarded-Host`.

## CORS and casting

Chromecast receivers fetch media from a different origin, so these routes (and only these) send `Access-Control-Allow-Origin: *`, for `GET`, `HEAD` and `OPTIONS`, with `Range` allowed and `Content-Range`, `Accept-Ranges` and `Content-Length` exposed:

- `/api/videos/{id}/stream` (original and `?rendition=compat`)
- `/api/videos/{id}/subtitles/{lang}`
- `/api/thumbnails/{id}`

Any website can therefore read those files if it knows the video id. That is the price of casting without a login.

## Private URLs { #private-urls }

Horde downloads things for you: thumbnails from a URL, and yt-dlp link checks, previews, downloads and playlist imports. Each URL must be `http` or `https` and must resolve only to public addresses. Loopback, private, link-local (including cloud metadata addresses), CGNAT, multicast and reserved ranges are refused. Redirects are followed by hand, at most five, and every hop is checked again. Remote thumbnails are capped at 15 MB, decoded as an image and stored as a fresh JPEG.

If you download from LAN sources (a NAS, a local media server), set `HORDE_ALLOW_PRIVATE_URLS=1`. The scheme rule stays in force.

Where the check applies:

- **Validated, per hop:** thumbnail fetches (connection pinned to the checked address, redirects re-checked, hosts that do not resolve are refused) and every URL the preview proxy fetches on an extractor's behalf: media, subtitles, manifests and the DASH index probe (redirects re-checked).
- **Pre-flight only:** URLs handed to yt-dlp (downloads, link checks, playlist and channel reads) are checked before the call, and the download queue re-checks each job before it starts. yt-dlp then resolves hostnames and follows redirects **itself**; those internal requests are not validated, so a DNS server that answers differently the second time, or a redirect inside yt-dlp, can still reach an internal address.
- **Not filtered:** the Ollama address in Settings → AI is a LAN host by design (an admin-only setting).

## Upload limits { #upload-limits }

| Upload | Limit | Checked |
|--------|-------|---------|
| Fonts | 8 MB, 50 stored | TTF / OTF / WOFF / WOFF2 signature |
| Backgrounds | 100 MB, 50 stored | Images decoded; WebM signature |
| Video thumbnails, playlist covers | 15 MB | Decoded and re-encoded as JPEG |
| Import (video file) | `HORDE_MAX_UPLOAD_GB` (default 50) | Playable by ffprobe; 1 GB of disk must stay free |
| Any other request body | 8 MB | |

Too large gives HTTP 413. Settings (`ui`) are capped at 256 KB; custom CSS at 64 000 characters.

Other limits: bulk endpoints take at most 1000 items (5000 for playlist entries); link previews run at most three at a time with a 60 second timeout (HTTP 429 / 504); at most `HORDE_YTDLP_REQUEST_THREADS` (default 8) requests are inside yt-dlp work at once, and the rest wait up to 15 seconds for a slot (HTTP 429) without occupying a server thread; thumbnail-candidate grabs run two at a time.

## Content-Security-Policy

Every response carries `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` and framing is limited to the same origin. The policy lists what the app actually loads:

- scripts: its own bundle and the Google Cast sender SDK (`www.gstatic.com`)
- styles: its own, Google Fonts (`fonts.googleapis.com`, for the optional UI font) and inline styles (the web app's own and your custom CSS)
- images: its own, plus remote thumbnails over HTTPS (YouTube's `i.ytimg.com` and other sites yt-dlp reads)
- connections: its own API and SponsorBlock (`sponsor.ajay.app`)

The wiki under `/wiki` has a separate, looser policy because the documentation theme uses inline scripts.

## Safari and iOS

Some stored files must be rewritten (AAC audio, faststart) before WebKit can play them. This never happens as a side effect of a `GET`. The player asks with `POST /api/videos/{id}/compat/safari`, waits for the job and then plays.
