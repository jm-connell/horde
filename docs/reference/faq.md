# FAQ

## How do I install Horde?

Clone [the git repo](https://github.com/jm-connell/horde) onto the Docker host, copy `.env.example` to `.env`, set `PUID` / `PGID` / `DOWNLOADS_PATH` / `DATA_PATH`, then `docker compose up -d` (it downloads the published image). Unraid, Synology, Portainer or plain `docker run`: [Other platforms](../getting-started/other-platforms.md). On TrueNAS, clone into Dockge’s stacks directory and **Scan Stacks Folder** — do not paste compose into **Add Stack** alone. Walkthroughs: [Install with Docker](../getting-started/install-docker.md), [TrueNAS / Dockge](../getting-started/truenas-dockge.md). Later: `bash update.sh` on the host ([Updating](../getting-started/updating.md)).

## Is there authentication?

**Yes.** The first visit creates the administrator account, who adds other people; everyone has their own watch history. Keep it on a **trusted LAN** (or behind your own VPN / SSO gateway). Details: [Accounts and sign-in](../ops/authentication.md), [Security model](../design/no-auth.md).

## What ports does it use?

Open Horde at **8686** on the host (`http://<server-ip>:8686`). Inside its container it listens on 8080 (API, web UI and wiki), and the stock compose file publishes that as 8686; to use another host port, see [Change the port](../ops/ports-networking.md#change-the-port). Ollama, OpenRouter, and optional POT/bgutil are separate services with their own URLs. See [Ports & networking](../ops/ports-networking.md).

## Is AI required?

**No.** Download, organize, browse, and watch work without Ollama or OpenRouter. AI adds embeddings, richer search, tags, summaries, chat, duplicates, and recommendations when you configure providers. See [Local vs cloud AI](../design/local-vs-cloud-ai.md).

## Why does Settings say GPU: none detected?

The **GPU** card under Settings → System → Resources only sees devices inside the **`horde` container**. Stock compose leaves passthrough commented out, so **None detected** is normal. Horde does not need a GPU to download, browse, or play the library (AV1-only and H.264-up-to-1080p modes copy the stream). A GPU on this host only speeds up H.264 encodes: compatibility copies of existing videos and imports, and full-resolution H.264 conversion. Local Ollama is a separate pass-through (or another machine). How to connect one: [GPU](../ops/environment.md#gpu).

## Is it YouTube only?

**YouTube-first**, but ingestion uses **yt-dlp**, so many other sites can work. Non-YouTube sources are less tested; metadata, POT, catalog sync, and SponsorBlock assumptions are YouTube-oriented. Paste a URL and see; keep expectations calibrated.

## How do I back up?

Back up the **data** volume (SQLite DB, thumbnails, app settings) and the **downloads** volume (media). Restoring both keeps paths and rows aligned. Settings → System → **Backup** summarizes this and links the full guide. See [Backup & restore](../ops/backup-restore.md) and [Storage layout](../ops/storage-layout.md).

## How do I update?

Run **`bash update.sh`** on the host (not Dockge Bash), or use **Update now** in Settings → System. It moves to the newest release and pulls the published image (or rebuilds it, on an install that builds from source). Settings, the SQLite library, and media stay on `DATA_PATH` / `DOWNLOADS_PATH` in `.env` — do not hardcode those only in `docker-compose.yml`. Settings → System shows when a newer release is out. See [Updating](../getting-started/updating.md).

## Where is the wiki in development?

In Docker/production, the wiki is built into the image and served at **`/wiki/`**. Locally, `./start.sh` builds the same tree into `backend/static/wiki/` by default (skip with `SKIP_WIKI=1`). The app only serves `/wiki/` when that directory exists. API Swagger remains at **`/docs`**. See [Local development](../getting-started/local-dev.md) and [Single container](../design/single-container.md).

## Do members-only / paid YouTube videos work?

Only if **yt-dlp on your server** can access them — typically with cookies from a signed-in account that has membership. Horde tries the video anonymously first and only then retries **that video** with cookies. It does not bypass YouTube membership paywalls. Bot checks and PO tokens are a separate problem; see [YouTube access](../ops/youtube-access.md).

## Why did my download fail with “Bot check” / “PO token”?

YouTube challenged the extract. Check Settings → System → Status (POT provider, cookies, **Last extract failure**), then [YouTube access](../ops/youtube-access.md) and [Troubleshooting](../ops/troubleshooting.md#bot-checks-youtube-blocks). Download cards show a typed `error_kind` with a short fix hint.

## Can I expose this to the internet?

Prefer a VPN (Tailscale / WireGuard): nothing is published. If you do want a public name, it can be done properly with TLS, a trusted proxy, `HORDE_ALLOWED_HOSTS` and required two-step sign-in; follow the [internet exposure checklist](../ops/internet-exposure.md) and read its remaining risks. See also [Remote access](../ops/remote-access.md) and [Security model](../design/no-auth.md).

## Can I restyle the UI with custom CSS?

Yes. Turn on **Enable custom CSS** under **Settings → Appearance → Custom CSS**, then paste a stylesheet (Jellyfin-style). Prefer CSS variables and `data-horde` / `data-page` hooks; see [Custom CSS](../settings/custom-css.md). There is no generated dump of every HTML node — that would go stale whenever the React tree changes.

## What license is Horde under?

**[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).** You may run, modify, and share Horde for personal and other noncommercial purposes (homelab, hobby, private entertainment; also schools, charities, and similar noncommercial organizations). You may **not** sell it, wrap it as a paid product or hosted service, or otherwise use it commercially.

This is **not** an OSI-approved “open source” license (MIT/Apache/GPL all allow commercial use). The full terms, including a required copyright notice, are in `LICENSE` at the repository root.

## Who wrote this?

One person, with AI coding assistants writing most of the code. Every change has to pass the same automated test suite before it can ship, and installs follow tagged releases that roll back by themselves if they fail to start: [how Horde is built](../design/vibecoded.md). Questions and bugs: **Ask** at the bottom of every page answers from this documentation, and **Report a bug or idea** in Horde's footer opens a [GitHub issue](https://github.com/jm-connell/horde/issues).
