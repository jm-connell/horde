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

### OpenAPI export and versioning

`python -m app.export_openapi [FILE]` writes the schema without starting the server (sorted, stable output). `backend/openapi.json` is the committed copy: `scripts/check.sh` and CI run `python -m app.export_openapi --check openapi.json` and fail when it is stale, so regenerate it (`python -m app.export_openapi openapi.json`) in any change that touches the API. It is the input for the frontend types: `npm run gen:api` (in `frontend/`) turns it into `src/api/schema.d.ts` with `openapi-typescript`, and `npm run gen:api:check` (run by `scripts/check.sh` and CI) fails when that file is stale. `src/types.ts` aliases the generated schemas instead of redeclaring them, and `src/api/typed.ts` reads response and body types straight from the generated paths, so a renamed route fails `tsc`. After an API change run `python -m app.export_openapi openapi.json` in `backend/`, then `npm run gen:api` in `frontend/`.

The API is **not** versioned in the URL: the only client is the web UI shipped in the same image, so the two always change together. A change that would break a script calling the API directly is listed under *Upgrade notes* in the [changelog](https://github.com/jm-connell/horde/blob/main/CHANGELOG.md). A `/api/v1` prefix was considered and left out for now: the sign-in check, the media-route CORS, signed media links, upload limits and the offline cache keys all match on the literal `/api/...` paths, so a second prefix would have to be threaded through each of them (and existing offline downloads are keyed by the old URLs).

### Thumbnails

`has_thumbnail` in a video payload means a thumbnail path is stored for it, not that the file was checked: a list page would otherwise stat one file per card. If someone deletes a file under `data/thumbnails` by hand, `GET /api/thumbnails/{id}` answers `404` and the UI shows its placeholder until the thumbnail is grabbed again. Horde itself only removes thumbnail files together with the video row.

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

### Pagination

`GET /api/videos` and `GET /api/review` return a page, not a bare list:

```json
{ "items": [ ... ], "next_cursor": "eyJ0IjoiayIs...", "total": null }
```

| Parameter       | Meaning                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `limit`         | Rows per page, 1 to 500 (default 100)                                                                     |
| `cursor`        | The previous page's `next_cursor`. Opaque: do not build or edit one. Missing means the first page         |
| `include_total` | `true` adds `total` (the number of matches). Off by default because counting is an extra query            |

Follow `next_cursor` until it is `null`. Library cursors are keyset cursors (the sort value and id of the last row), so a video added or removed between two requests never repeats or skips a row. `sort=random` is a keyset walk too: each video's place in the shuffle is a keyed hash of its id and the seed (the cursor carries the seed), so it does not move when other videos come or go. Text search (`q`) ranks hits in Python, so its cursor is a position in that ranking. A cursor only works with the `sort` and `order` it was issued for and with the kind of listing that issued it; anything else, and any cursor whose contents do not fit (wrong type, out of range), is a `400`. The *Continue watching* shelf (`continue_watching=true`) is at most 12 rows and is never paged.

`GET /api/review/groups` pages the same way (`limit` 1 to 100 groups, default 25; only the groups on the page are checked by AI). `GET /api/tags` (alphabetical, `limit` up to 5000, default 1000) and `GET /api/tags/stats` (most used first, `limit` up to 2000, default 500) page with `next_cursor` too and return `{items, next_cursor}`; the web UI follows the cursors, so every tag is listed. `GET /api/playlists` is capped (`limit` up to 1000 with `offset`), since a library has dozens.

The web UI asks for 500 rows at a time and keeps following the cursor, painting the first page as soon as it arrives. A library under 500 videos therefore takes one request, exactly as before.

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
