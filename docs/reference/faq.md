# FAQ

## Is there authentication?

**No.** Horde is a single-admin app with no login. Keep it on a **trusted LAN** (or behind your own VPN / SSO gateway). Details: [No authentication](../design/no-auth.md).

## What ports does it use?

The container listens on **8080** by default (API + SPA + wiki). Map that port in Compose / Dockge. Ollama, OpenRouter, and optional POT/bgutil are separate services with their own URLs. See [Ports & networking](../ops/ports-networking.md).

## Is AI required?

**No.** Download, organize, browse, and watch work without Ollama or OpenRouter. AI adds embeddings, richer search, tags, summaries, chat, duplicates, and recommendations when you configure providers. See [Local vs cloud AI](../design/local-vs-cloud-ai.md).

## Is it YouTube only?

**YouTube-first**, but ingestion uses **yt-dlp**, so many other sites can work. Non-YouTube sources are less tested; metadata, POT, catalog sync, and SponsorBlock assumptions are YouTube-oriented. Paste a URL and see; keep expectations calibrated.

## How do I back up?

Back up the **data** volume (SQLite DB, thumbnails, app settings) and the **downloads** volume (media). Restoring both keeps paths and rows aligned. See [Backup & restore](../ops/backup-restore.md) and [Storage layout](../ops/storage-layout.md).

## How do I update?

Pull the latest git revision and **rebuild** the image (`docker compose up --build -d` or Dockge rebuild). Horde is typically built from source on the host, not pulled as a fixed registry tag. Settings → System can notice a newer GitHub commit. See [Updating](../getting-started/updating.md).

## Where is the wiki in development?

In Docker/production, the wiki is built into the image and served at **`/wiki/`**. For local docs work, run MkDocs against `mkdocs.yml` (Material theme) from the repo; the app only serves `/wiki/` when `static/wiki` (or the image equivalent) exists. API Swagger remains at **`/docs`**. See [Local development](../getting-started/local-dev.md) and [Single container](../design/single-container.md).

## Do members-only / paid YouTube videos work?

Only if **yt-dlp on your server** can access them — typically with appropriate cookies / account configuration on the host. Horde does not bypass YouTube membership paywalls by itself. Bot checks and PO tokens are a separate problem; see [YouTube access](../ops/youtube-access.md).

## Can I expose this to the internet?

**Not recommended** without your own auth layer. CORS is wide for Chromecast, and there is no app login. Prefer VPN. See [No authentication](../design/no-auth.md).

## Who wrote this?

It was [vibecoded](../design/vibecoded.md) in Cursor with AI assistants. For questions, open the repo in Ask mode rather than expecting a full-time support desk.
