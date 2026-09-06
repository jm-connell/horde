# FAQ

## Is there authentication?

**No.** Horde is a single-admin app with no login. Keep it on a **trusted LAN** (or behind your own VPN / SSO gateway). Details: [No authentication](../design/no-auth.md).

## What ports does it use?

The container listens on **8080** by default (API + SPA + wiki). Map that port in Compose / Dockge. Ollama, OpenRouter, and optional POT/bgutil are separate services with their own URLs. See [Ports & networking](../ops/ports-networking.md).

## Is AI required?

**No.** Download, organize, browse, and watch work without Ollama or OpenRouter. AI adds embeddings, richer search, tags, summaries, chat, duplicates, and recommendations when you configure providers. See [Local vs cloud AI](../design/local-vs-cloud-ai.md).

## Why does Settings say GPU: none detected?

The **GPU** card under Settings → System → Resources only sees devices inside the **`horde` container**. Stock compose leaves passthrough commented out, so **None detected** is normal. Horde does not need a GPU to download, browse, or play the library (default AV1 copies the bitstream; 1080p H.264 does too). A GPU on this host only speeds 1440p/4K H.264/H.265 archive transcode. Local Ollama is a separate pass-through (or another machine). How to connect one: [GPU](../ops/environment.md#gpu).

## Is it YouTube only?

**YouTube-first**, but ingestion uses **yt-dlp**, so many other sites can work. Non-YouTube sources are less tested; metadata, POT, catalog sync, and SponsorBlock assumptions are YouTube-oriented. Paste a URL and see; keep expectations calibrated.

## How do I back up?

Back up the **data** volume (SQLite DB, thumbnails, app settings) and the **downloads** volume (media). Restoring both keeps paths and rows aligned. Settings → System → **Backup** summarizes this and links the full guide. See [Backup & restore](../ops/backup-restore.md) and [Storage layout](../ops/storage-layout.md).

## How do I update?

Pull the latest git revision with **`bash update.sh`** on the host (not Dockge Bash) and **rebuild** the image. Horde is typically built from source on the host, not pulled as a fixed registry tag. Settings, the SQLite library, and media stay on `DATA_PATH` / `DOWNLOADS_PATH` in `.env` — do not hardcode those only in `docker-compose.yml`. Settings → System can notice a newer GitHub commit. See [Updating](../getting-started/updating.md).

## Where is the wiki in development?

In Docker/production, the wiki is built into the image and served at **`/wiki/`**. Locally, `./start.sh` builds the same tree into `backend/static/wiki/` by default (skip with `SKIP_WIKI=1`). The app only serves `/wiki/` when that directory exists. API Swagger remains at **`/docs`**. See [Local development](../getting-started/local-dev.md) and [Single container](../design/single-container.md).

## Do members-only / paid YouTube videos work?

Only if **yt-dlp on your server** can access them — typically with appropriate cookies / account configuration on the host. Horde does not bypass YouTube membership paywalls by itself. Bot checks and PO tokens are a separate problem; see [YouTube access](../ops/youtube-access.md).

## Why did my download fail with “Bot check” / “PO token”?

YouTube challenged the extract. Check Settings → System → Status (POT provider, cookies, **Last extract failure**), then [YouTube access](../ops/youtube-access.md) and [Troubleshooting](../ops/troubleshooting.md#bot-checks-youtube-blocks). Download cards show a typed `error_kind` with a short fix hint.

## Can I expose this to the internet?

**Not recommended** without your own auth layer. CORS is wide for Chromecast, and there is no app login. Prefer a VPN (Tailscale / WireGuard) or put HTTP Basic Auth / SSO on a reverse proxy in front of Horde. See [Remote access](../ops/remote-access.md) and [No authentication](../design/no-auth.md).

## Can I restyle the UI with custom CSS?

Yes. Turn on **Enable custom CSS** under **Settings → Appearance → Custom CSS**, then paste a stylesheet (Jellyfin-style). Prefer CSS variables and `data-horde` / `data-page` hooks; see [Custom CSS](../settings/custom-css.md). There is no generated dump of every HTML node — that would go stale whenever the React tree changes.

## Who wrote this?

It was [vibecoded](../design/vibecoded.md) in Cursor with AI assistants. For questions, open the repo in Ask mode rather than expecting a full-time support desk.
