# API overview

Horde exposes an HTTP JSON API under the **`/api`** prefix, served by the same process as the UI. There is **no authentication**.

!!! danger "LAN trust"
    Any client that can reach the port can mutate the library and settings. See [No authentication](../design/no-auth.md) and [Ports & networking](../ops/ports-networking.md).

## Conventions

| Topic | Detail |
|-------|--------|
| Prefix | `/api/...` for application routes |
| Auth | None |
| Interactive docs | **`/docs`** (Swagger UI) |
| OpenAPI schema | **`/openapi.json`** |

Use `/docs` as the live catalog of request/response shapes. This wiki does **not** enumerate every endpoint.

## Notable patterns

### SSE (Server-Sent Events)

| Endpoint pattern | Use |
|------------------|-----|
| `/api/downloads/{id}/events` | Live download progress for a job |
| AI chat stream routes under `/api/ai/...` | Token/streamed chat replies |

Clients typically use `EventSource` for downloads and fetch/stream readers for chat.

### Range streaming

Library (and preview) media endpoints support HTTP **Range** requests so the browser player and cast receivers can seek efficiently. CORS exposes `Content-Range` / `Accept-Ranges` for cross-origin cast. See [Ports & networking](../ops/ports-networking.md).

### Health

`GET /api/health` is kept **probe-cheap** (no remote model lists, no yt-dlp extract). It returns:

| Field | Meaning |
|-------|---------|
| `status`, `horde_sha`, `horde_version`, `yt_dlp_version` | Process / build identity |
| `pot_provider` | bgutil POT ping (`ok` / `error`) |
| `ollama` / `openrouter` | Enabled/ready summaries; Ollama may include `last_error` |
| `disk` | Free/used/total on `DOWNLOADS_DIR` |
| `library_video_count`, `review_pending_count`, `active_downloads` | Library snapshot |
| `wiki_available` | MkDocs static tree present |
| `downloads` | `{ active, paused }` — pause from in-memory queue + `download_queue_paused` |
| `workers` | `{ ai_queue_depth, ai_running, catalog_queue_depth, catalog_indexing }` |
| `youtube` | `{ cookies_configured, last_extract_failure }` — last classified extract error |

Settings → System → Status renders this snapshot. Full AI model detail remains on `GET /api/ai/status`.

## Related

- [Backend](backend.md)
- [Download pipeline](downloads-pipeline.md)
- [AI pipeline](ai-pipeline.md)
- [Overview](overview.md)
