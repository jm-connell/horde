# API overview

Horde exposes an HTTP JSON API under the **`/api`** prefix, served by the same process as the UI. Every route requires a signed-in session (cookie `horde_session`) except a short public list; see [Accounts and sign-in](../ops/authentication.md).

!!! danger "LAN trust"
Signed-in clients can mutate the library; server settings need an administrator and several actions need a [permission](../ops/authentication.md#account-types-and-permissions). See [Security model](../design/no-auth.md) and [Ports & networking](../ops/ports-networking.md).

## Conventions

| Topic            | Detail                                                            |
| ---------------- | ----------------------------------------------------------------- |
| Prefix           | `/api/...` for application routes                                 |
| Auth             | Session cookie; see [Accounts and sign-in](../ops/authentication.md) |
| Errors           | One envelope for every error, see below                           |
| Interactive docs | **`/docs`** (Swagger UI)                                          |
| OpenAPI schema   | **`/openapi.json`**                                               |

Use `/docs` as the live catalog of request/response shapes. This wiki does **not** enumerate every endpoint.

### Response models

Every JSON route declares a `response_model`; routes that send bytes, files or event streams declare the media type in `responses=` instead (`app/openapi_responses.py`). `tests/test_response_models.py` fails when a new route does neither, so `/openapi.json` always describes what the API returns.

### Errors

Every error response, whichever layer raised it (host check, CSRF, sign-in, validation, a route, or an unexpected crash), has the same JSON body:

```json
{ "detail": "Already in library", "code": "already_in_library" }
```

| Field        | Meaning                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `detail`     | Human readable message. Always a string.                                                                             |
| `code`       | Stable `snake_case` identifier to branch on (`auth_required`, `permission_denied`, `already_queued`, `not_found`, `validation_error`, `internal_error`, ...). When a route does not name one, it is derived from the status (`404` is `not_found`). |
| `fields`     | Validation errors (`422`, `code: validation_error`) only: a list of `{loc, msg}`. `detail` already joins them into a sentence. |
| `extra`      | Optional machine readable context. Link-reading failures carry `extra.error_kind` (`pot`, `members_only`, ...).      |
| `request_id` | Unexpected errors only (`500`, `code: internal_error`): the same value as the `X-Request-ID` header, to find the traceback in the [log](../ops/logging.md). The message never contains internals. |

## Notable patterns

### SSE (Server-Sent Events)

| Endpoint pattern                          | Use                                                     |
| ----------------------------------------- | ------------------------------------------------------- |
| `/api/downloads/events`                   | Live progress for the whole queue (`job_id` + snapshot) |
| `/api/downloads/{id}/events`              | Live download progress for a single job                 |
| AI chat stream routes under `/api/ai/...` | Token/streamed chat replies                             |

Clients typically use `EventSource` for downloads and fetch/stream readers for chat.

### Range streaming

Library (and preview) media endpoints support HTTP **Range** requests so the browser player and cast receivers can seek efficiently. CORS exposes `Content-Range` / `Accept-Ranges` for cross-origin cast. See [Ports & networking](../ops/ports-networking.md).

`GET /api/videos/{id}/stream` and `/file` take an optional `?rendition=original|compat`. `compat` serves the H.264 sidecar (`404 compat_unavailable` when none exists; any other value is `400`). Without it the original is served.

### H.264 compatibility copies

| Route | Purpose |
|-------|---------|
| `GET /api/videos/{id}/compat` | Copy state: `status` (`none` \| `queued` \| `running` \| `ready` \| `error`), `stage` (`downloading` \| `encoding` \| `finishing`), `progress`, `error` |
| `POST /api/videos/{id}/compat` | Create the copy for one video (body `prefer_download`, default `true`; `false` always encodes locally). Jumps the queue. `409` if the video is already ≤1080p 8-bit H.264 |
| `DELETE /api/videos/{id}/compat` | Cancel any job, delete the sidecar file, clear the row fields |
| `GET /api/compat/summary` | Library totals: size, codec counts, copies ready/missing (with estimated bytes), convertible originals, queue counts |
| `POST /api/compat/backfill` | Queue copies for every ready, non-review video that would benefit |
| `POST /api/compat/convert-library` | Re-encode all non-H.264 originals in place. Body must carry `confirm: true` (else `400`) |
| `POST /api/compat/cancel` | Drop queued jobs and signal running ones (body `kind`: `compat` \| `convert`, optional) |

Video payloads carry the probed codec fields, `has_compat` on lists, and `compat` (state) on detail. `GET /api/stats/storage` includes `compat_bytes` in its totals.

### List vs. detail video payloads

`GET /api/videos` (including `continue_watching`, search, and `watched_only`) and `GET /api/videos/{id}/related` return **card-sized** payloads (no description/chapters/AI meta, no disk stats). Fetch `GET /api/videos/{id}` for the full detail record.

### Health

`GET /api/ping` (liveness), `GET /api/ready` (database, migrations, workers; `503` when not ready) and `GET /api/metrics` (Prometheus text) are documented under [Monitoring](../ops/monitoring.md).

`GET /api/health` is kept **probe-cheap**: it forks nothing and never waits on the network (the yt-dlp version, git SHA and ffmpeg build info are read once at startup, and the POT sidecar status is refreshed in the background every 30 s). It returns:

| Field                                                             | Meaning                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `status`, `horde_sha`, `horde_version`, `yt_dlp_version`          | Process / build identity                                                                                                        |
| `ffmpeg`                                                          | `{ flavor, version }` from the image's `/app/BUILD_INFO`; `null` outside the image                                              |
| `pot_provider`                                                    | bgutil POT status (`ok` / `error` / `pending` before the first probe), cached up to 30 s                                        |
| `storage_warning`                                                 | Message when `DATA_DIR` is on a network filesystem (SQLite WAL is unsafe there), else `null`                                    |
| `ollama` / `openrouter`                                           | Enabled/ready summaries; Ollama may include `last_error`                                                                        |
| `disk`                                                            | Free/used/total on `DOWNLOADS_DIR`                                                                                              |
| `library_video_count`, `review_pending_count`, `active_downloads` | Library snapshot                                                                                                                |
| `wiki_available`                                                  | MkDocs static tree present                                                                                                      |
| `downloads`                                                       | `{ active, paused }` — pause from in-memory queue + `download_queue_paused`                                                     |
| `workers`                                                         | `{ ai_queue_depth, ai_running, catalog_queue_depth, catalog_indexing }`                                                         |
| `youtube`                                                         | `{ cookies_configured, last_extract_failure }` — last classified extract error (kind, message, optional video/channel `target`) |

Settings → System → Status renders this snapshot. Full AI model detail remains on `GET /api/ai/status`.

## Related

- [Backend](backend.md)
- [Download pipeline](downloads-pipeline.md)
- [AI pipeline](ai-pipeline.md)
- [Overview](overview.md)
