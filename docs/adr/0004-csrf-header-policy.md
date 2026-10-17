# 0004. CSRF: a request header and `Sec-Fetch-Site`, no tokens

Status: Accepted

## Context

Once sign-in uses a cookie, a web page the user visits can make their browser send requests to the Horde address (`http://truenas:8686`) with the cookie attached. Horde's API is JSON, consumed by one first-party SPA that ships in the same image, and the audience scripts it occasionally with `curl`. The classic defence is a synchroniser or double-submit token, which needs server-side token state, a way to hand the token to the SPA and to the service worker, and extra plumbing for scripts and uploads.

There is also a second web-to-LAN risk that cookies do not cover: DNS rebinding, where an attacker's domain re-points at the LAN address and the page becomes same-origin with Horde.

## Decision

`CsrfMiddleware` (`app/security.py`) rejects every request whose method is not `GET`, `HEAD` or `OPTIONS` with `403` and code `csrf_rejected` unless:

1. it carries `X-Horde-Request: 1`;
2. it does not carry `Sec-Fetch-Site: cross-site`; and
3. if it carries an `Origin`, that origin's host equals the request `Host` (or the first `X-Forwarded-Host`).

Why a custom header is enough: a page on another site can only add a non-simple header through `fetch`/XHR after a **CORS preflight**, and Horde answers no preflight for any such route. The only CORS in the app is `MediaCorsMiddleware`, which covers GET/HEAD/OPTIONS on the stream, subtitle and thumbnail routes and allows only `Range` and `Content-Type` headers, so even there the header cannot be granted. A plain cross-site `<form>` cannot set the header at all. `Sec-Fetch-Site` and `Origin` are defence in depth for browsers that send them: a request that is flagged cross-site, or whose `Origin` is not this server, is refused even if it somehow carried the header.

`HostAllowlistMiddleware`, ahead of it in the stack, answers `400` for a `Host` that is not a private address, a single-label name, a private suffix (`.local`, `.lan`, `.home.arpa`, `.internal`, `.ts.net`), or listed in `HORDE_ALLOWED_HOSTS`. That is the rebinding defence. The order is a single list, `build_stack()`, with `AuthMiddleware` slotted after `CsrfMiddleware`.

Companion rules: **no destructive `GET`** (a GET only serves what exists; the Safari remux is a `POST`), `SameSite=Lax` on the session cookie, and `frontend/src/api.ts` adds the header to every request (`withCsrf`/`CSRF_HEADER`), including the upload `XMLHttpRequest`. Any new mutating `fetch` must use it.

## Consequences

- No token endpoint, no token storage, no rotation, nothing for the service worker or the offline cache to keep in sync; stateless and invisible to the SPA.
- Scripts must send `X-Horde-Request: 1` on `POST`/`PUT`/`PATCH`/`DELETE`. This is documented, and the test `client` fixture does it.
- The protection depends on **no route ever granting a CORS preflight for other origins** and on GET staying safe. Both are tested (`tests/test_security.py` covers the header, fetch metadata, `Origin`, and that only media routes answer a preflight); widening CORS is a security change.
- A browser that sends neither `Sec-Fetch-Site` nor `Origin` is still protected by the header alone.
- Because the header is checked before authentication, an unauthenticated cross-site probe learns nothing about whether a session exists.
- It is the right size for a LAN app. It is not a reason to expose Horde publicly ([ADR 0003](0003-auth-model.md)).

Detail: [Security](../ops/security.md).
