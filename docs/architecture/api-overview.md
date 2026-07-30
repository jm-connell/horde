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

`GET /api/health` returns process readiness plus library counts, disk usage, Ollama/OpenRouter summaries, POT provider status, git SHA, and `wiki_available`.

## Related

- [Backend](backend.md)
- [Download pipeline](downloads-pipeline.md)
- [AI pipeline](ai-pipeline.md)
- [Overview](overview.md)
