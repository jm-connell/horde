# 0005. One error envelope, cursor pagination, and no `/api/v1` yet

Status: Accepted

## Context

The API grew route by route. Errors came back as `{"detail": "text"}`, `{"detail": {...}}`, a validation list, plain text from middleware or an HTML 500, so the SPA had to guess and could not branch on cause. List endpoints returned bare arrays (or offset pages), which repeat and skip rows when the library changes between requests and force the server to materialise everything for a "page". The OpenAPI document was incomplete because many routes returned ad-hoc dicts.

A URL version prefix (`/api/v1`) is the textbook answer to "how do we evolve this". But the only client is the SPA shipped in the same image, so client and server always change together, and several things match on the literal `/api/...` path.

## Decision

**One error envelope.** Every error response, whichever layer produced it (host check, CSRF, sign-in, validation, a route, an unexpected crash), has the body `{detail, code, fields?, extra?, request_id?}` (`app/errors.py`, `ErrorResponse`).

- `detail` is always a human-readable string, so a client that only shows a message keeps working.
- `code` is a stable `snake_case` identifier to branch on (`auth_required`, `permission_denied`, `csrf_rejected`, `already_queued`, `validation_error`, ...). If a route names none, it is derived from the status.
- `fields` carries validation errors (`loc`, `msg`); `extra` carries machine-readable context (for example `error_kind`); `request_id` appears on unexpected `500`s only and equals the `X-Request-ID` header, so a user can quote it and the traceback can be found in the log. A `500` never contains internals.
- Handlers for `HTTPException`, `RequestValidationError`, the domain errors (`AccountError`, `UnsafeUrlError`) and a catch-all are installed once by `install_error_handlers`. The SPA turns any of them into an `ApiError` (`api.ts`, `apiErrors.ts`).

**Response models everywhere.** Every JSON route declares a `response_model`; byte, file and event-stream routes declare a media type in `openapi_responses.py`. `tests/test_response_models.py` fails otherwise. `backend/openapi.json` is committed and `scripts/check.sh` and CI run `python -m app.export_openapi --check openapi.json`; any API change regenerates it.

**Cursor pagination.** List endpoints return `{items, next_cursor, total?}` (for videos and review, `limit` 1 to 500, default 100; `total` only with `include_total=true`; tags use default 1000, max 5000, and review groups default 25, max 100). A cursor is an opaque URL-safe base64 JSON token (`services/pagination.py`) of one of two kinds: **keyset** (sort value and id of the last row, so rows added or removed between requests never shift a page) or **offset** (for orders SQL cannot express, such as ranked text-search hits). `sort=random` is a keyset walk over a keyed hash of the id and a seed carried in the cursor, so the shuffle is stable when other videos come and go. A cursor records the `sort`/`order` and listing kind it was issued for and is refused (`400`) when replayed with others, when malformed, out of range, forged, or carrying a naive timestamp. Tags and review groups page the same way; the SPA follows cursors, asking for 500 at a time and painting the first page immediately.

**No `/api/v1` prefix for now.** The paths are matched literally by: the sign-in allowlist and signed-media patterns (`/api/videos/(\d+)/stream` and friends), the media-only CORS rule, per-route upload limits, the permission table in the tests, and, on the client, the **offline cache**: the service worker intercepts `/api/videos/{id}/stream` and offline extras (thumbnails, subtitles) are stored in Cache Storage under their real API URLs, and links already handed to a cast receiver contain the path. A second prefix would have to be threaded through every one of those, and existing offline downloads would be orphaned. Breaking changes that could affect a script are listed under *Upgrade notes* in the changelog instead.

## Consequences

- Clients branch on `code`, never on message text. Changing a `code` is a breaking change; adding one is not.
- A paged list needs a loop, not a single call. A library under 500 videos is still one request.
- The committed `openapi.json` makes API drift visible in review and gives a stable input for client types.
- If a real second client appears, or the SPA and server stop shipping together, add `/api/v1` then, as a mount plus an alias for the old paths, and update the places above in the same change. The deferral is a cost-benefit call, not a rejection.

Detail: [API overview](../architecture/api-overview.md).
