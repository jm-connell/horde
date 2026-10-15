"""In-app YouTube stream preview (progressive proxy + adaptive DASH)."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlmodel import Session
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from ..database import get_session
from ..schemas import StreamPreviewMeta
from ..services import library, stream_preview
from ..services.limits import ExtractionGate, extraction_gate, ytdlp_slot
from ..services.url_clean import _youtube_video_id, clean_url
from ..services.url_safety import MAX_REDIRECTS, REDIRECT_STATUSES, validate_public_url
from ..services.ytdlp_common import (
    ERROR_KIND_UNKNOWN,
    MembersOnlyError,
    classify_ytdlp_error,
    http_detail_for_error,
)

router = APIRouter(prefix="/api/preview", tags=["preview"])
logger = logging.getLogger(__name__)

_CHUNK = 512 * 1024
_CACHE_CONTROL = "private, max-age=1800, immutable"

_preview_client: httpx.AsyncClient | None = None


def get_preview_client() -> httpx.AsyncClient:
    if _preview_client is None:
        raise RuntimeError("Preview HTTP client is not initialized")
    return _preview_client


async def init_preview_client() -> None:
    global _preview_client
    if _preview_client is not None:
        return
    _preview_client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0),
        limits=httpx.Limits(
            max_connections=32,
            max_keepalive_connections=16,
            keepalive_expiry=60.0,
        ),
        follow_redirects=False,  # redirects are followed by _send_validated
    )


async def close_preview_client() -> None:
    global _preview_client
    client = _preview_client
    _preview_client = None
    if client is not None:
        await client.aclose()


def _require_video_url(url: str) -> str:
    cleaned = clean_url(url, keep_playlist=False)
    if not cleaned.strip():
        raise HTTPException(status_code=400, detail="URL is required")
    # DNS lookup blocks briefly; the async routes call this through to_thread.
    validate_public_url(cleaned)
    return cleaned


async def _send_validated(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    headers: dict[str, str],
    *,
    stream: bool,
) -> httpx.Response:
    """Send a request to a URL an extractor returned, checking every hop.

    yt-dlp can return any URL for a page it was pointed at, and CDNs redirect, so
    each URL (the first and every redirect target) must pass the same public-address
    check as user-supplied URLs. Raises UnsafeUrlError (HTTP 400) otherwise.
    """
    for _hop in range(MAX_REDIRECTS + 1):
        await run_in_threadpool(validate_public_url, url)
        request = client.build_request(method, url, headers=headers)
        response = await client.send(request, stream=stream)
        if response.status_code not in REDIRECT_STATUSES:
            return response
        location = response.headers.get("location")
        if stream:
            await response.aclose()
        if not location:
            raise HTTPException(
                status_code=502, detail="Upstream redirect had no target"
            )
        url = urljoin(url, location)
    raise HTTPException(status_code=502, detail="Upstream redirected too many times")


async def _open_upstream(
    client: httpx.AsyncClient,
    direct_url: str,
    headers: dict[str, str],
) -> httpx.Response:
    return await _send_validated(client, "GET", direct_url, headers, stream=True)


async def _close_upstream(upstream: httpx.Response | None) -> None:
    if upstream is None:
        return
    try:
        await upstream.aclose()
    except Exception:
        logger.debug(
            "closing the upstream preview response failed",
            exc_info=True,
        )


async def _in_ytdlp_thread(request: Request, fn, *args, **kwargs):
    """Run blocking yt-dlp work off the event loop, holding a yt-dlp slot.

    The async routes below cannot simply call the extractors: they block for seconds.
    The slot (see ``services/limits.py``) keeps those worker threads to a bounded few.
    """
    async with request.app.state.ytdlp_slots.slot():
        return await run_in_threadpool(fn, *args, **kwargs)


def _reresolve_preview(
    *,
    allow_refresh: tuple[str, str] | None = None,
    stream_url: str | None = None,
) -> dict:
    """Re-extract CDN URLs after a 401/403. Raises HTTPException on failure."""
    if allow_refresh is not None:
        token, itag = allow_refresh
        logger.warning("Refreshing preview media token=%s itag=%s", token[:8], itag)
        try:
            return stream_preview.lookup_preview_media(token, itag, refresh=True)
        except stream_preview.PreviewRefreshError as exc:
            logger.warning("Preview media refresh failed: %s", exc)
            raise HTTPException(
                status_code=503,
                detail=str(exc),
                headers={"Retry-After": str(exc.retry_after)},
            ) from exc
        except Exception as exc:
            logger.warning("Could not refresh preview media: %s", exc)
            raise HTTPException(
                status_code=502,
                detail=f"Could not refresh preview media: {exc}",
            ) from exc
    assert stream_url is not None  # noqa: S101 - type narrowing; unreachable otherwise
    logger.warning("Refreshing preview stream url=%s", stream_url[:80])
    try:
        return stream_preview.resolve_preview_stream(stream_url, force=True)
    except Exception as exc:
        logger.warning("Could not refresh preview stream: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not refresh preview stream: {exc}",
        ) from exc


async def _proxy_upstream(
    request: Request,
    resolved: dict,
    *,
    allow_refresh: tuple[str, str] | None = None,
    stream_url: str | None = None,
) -> StreamingResponse:
    """Proxy a CDN media URL with Range support.

    If allow_refresh is (token, itag) and upstream returns 403, refresh once.
    Progressive /stream uses stream_url the same way.
    """
    client = get_preview_client()
    upstream_headers = dict(resolved.get("http_headers") or {})
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    upstream: httpx.Response | None = None
    try:
        upstream = await _open_upstream(
            client, resolved["direct_url"], upstream_headers
        )
    except httpx.HTTPError as exc:
        logger.warning("Upstream stream open failed: %s", exc)
        raise HTTPException(
            status_code=502, detail=f"Upstream stream failed: {exc}"
        ) from exc

    can_refresh = allow_refresh is not None or stream_url is not None
    # Expired / PO-token-doomed CDN URL — re-resolve once and retry.
    if upstream.status_code in (401, 403) and can_refresh:
        await _close_upstream(upstream)
        upstream = None
        resolved = await _in_ytdlp_thread(
            request,
            _reresolve_preview,
            allow_refresh=allow_refresh,
            stream_url=stream_url,
        )
        upstream_headers = dict(resolved.get("http_headers") or {})
        if range_header:
            upstream_headers["Range"] = range_header
        try:
            upstream = await _open_upstream(
                client, resolved["direct_url"], upstream_headers
            )
        except httpx.HTTPError as exc:
            logger.warning("Upstream stream retry failed: %s", exc)
            raise HTTPException(
                status_code=502, detail=f"Upstream stream failed: {exc}"
            ) from exc

    assert upstream is not None  # noqa: S101 - type narrowing; the retry loop always sets it

    if upstream.status_code >= 400:
        try:
            detail = (await upstream.aread())[:200]
        except Exception:
            logger.debug("could not read the upstream error body", exc_info=True)
            detail = b""
        status = upstream.status_code
        await _close_upstream(upstream)
        logger.warning("Upstream returned %s: %r", status, detail)
        raise HTTPException(
            status_code=502,
            detail=f"Upstream returned {status}: {detail!r}",
        )

    status = upstream.status_code
    # Range requested but upstream ignored it — do not forward a full body with
    # wrong offsets (Shaka's MP4 parser would desync).
    if range_header and status == 200:
        await _close_upstream(upstream)
        logger.warning("Upstream ignored Range header; refusing full-body reply")
        raise HTTPException(
            status_code=502,
            detail="Upstream ignored Range request",
        )
    if status not in (200, 206):
        await _close_upstream(upstream)
        raise HTTPException(status_code=502, detail=f"Unexpected status {status}")

    out_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": _CACHE_CONTROL,
        "Content-Type": upstream.headers.get(
            "content-type", resolved.get("content_type") or "video/mp4"
        ),
    }
    # Intentionally omit Content-Length: a mid-stream upstream failure should
    # produce a truncated connection rather than a length-violating response.
    content_range = upstream.headers.get("content-range")
    if content_range:
        out_headers["Content-Range"] = content_range

    stream_upstream = upstream

    async def iter_bytes() -> AsyncIterator[bytes]:
        try:
            async for chunk in stream_upstream.aiter_bytes(chunk_size=_CHUNK):
                if chunk:
                    yield chunk
        finally:
            await _close_upstream(stream_upstream)

    return StreamingResponse(
        iter_bytes(),
        status_code=status,
        headers=out_headers,
        media_type=out_headers["Content-Type"],
        background=BackgroundTask(_close_upstream, stream_upstream),
    )


async def _head_upstream(
    request: Request,
    resolved: dict,
    *,
    allow_refresh: tuple[str, str] | None = None,
) -> Response:
    """HEAD proxy for adaptive media (CORS/preflight and player probes)."""
    client = get_preview_client()
    upstream_headers = dict(resolved.get("http_headers") or {})
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    try:
        resp = await _send_validated(
            client, "HEAD", resolved["direct_url"], upstream_headers, stream=False
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"Upstream HEAD failed: {exc}"
        ) from exc

    if resp.status_code in (401, 403) and allow_refresh is not None:
        resolved = await _in_ytdlp_thread(
            request, _reresolve_preview, allow_refresh=allow_refresh
        )
        upstream_headers = dict(resolved.get("http_headers") or {})
        if range_header:
            upstream_headers["Range"] = range_header
        try:
            resp = await _send_validated(
                client, "HEAD", resolved["direct_url"], upstream_headers, stream=False
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502, detail=f"Upstream HEAD failed: {exc}"
            ) from exc

    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Upstream returned {resp.status_code}",
        )

    out_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": _CACHE_CONTROL,
        "Content-Type": resp.headers.get(
            "content-type", resolved.get("content_type") or "video/mp4"
        ),
    }
    content_length = resp.headers.get("content-length")
    if content_length:
        out_headers["Content-Length"] = content_length
    content_range = resp.headers.get("content-range")
    if content_range:
        out_headers["Content-Range"] = content_range

    return Response(
        status_code=resp.status_code if resp.status_code in (200, 206) else 200,
        headers=out_headers,
    )


@router.get(
    "/meta", response_model=StreamPreviewMeta, dependencies=[Depends(ytdlp_slot)]
)
def preview_meta(
    url: str = Query(...),
    session: Session = Depends(get_session),
    gate: ExtractionGate = Depends(extraction_gate),
):
    cleaned = _require_video_url(url)
    try:
        meta = gate.run(stream_preview.extract_stream_preview_meta, cleaned)
    except HTTPException:
        raise  # 429 / 504 from the gate
    except MembersOnlyError as exc:
        raise HTTPException(
            status_code=400,
            detail=http_detail_for_error(
                exc, prefix="Could not load preview", url=cleaned
            ),
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        kind, _ = classify_ytdlp_error(exc, url=cleaned)
        detail = http_detail_for_error(
            exc, prefix="Could not load preview", url=cleaned
        )
        if kind == ERROR_KIND_UNKNOWN:
            logger.exception("stream preview meta failed for %r", cleaned)
            raise HTTPException(status_code=500, detail=detail) from exc
        raise HTTPException(status_code=400, detail=detail) from exc

    library_video_id = None
    yt_id = meta.get("id")
    if not yt_id:
        yt_id = _youtube_video_id(urlparse(cleaned))
    if yt_id:
        existing = library.find_video_by_youtube_id(session, str(yt_id))
        if existing is not None:
            library_video_id = existing.id

    return StreamPreviewMeta(
        id=meta.get("id"),
        title=meta.get("title"),
        channel=meta.get("channel"),
        channel_url=meta.get("channel_url"),
        thumbnail_url=meta.get("thumbnail_url"),
        description=meta.get("description"),
        duration=meta.get("duration"),
        view_count=meta.get("view_count"),
        source_url=meta.get("source_url"),
        preview_height=meta.get("preview_height"),
        library_video_id=library_video_id,
        available_presets=meta.get("available_presets") or [],
        subtitles=meta.get("subtitles") or [],
    )


@router.get("/subtitles")
async def preview_subtitles(
    request: Request,
    url: str = Query(...),
    lang: str = Query("en"),
):
    """Proxy an English (or requested) WebVTT caption track for stream preview."""
    cleaned = await run_in_threadpool(_require_video_url, url)
    try:
        resolved = await _in_ytdlp_thread(
            request, stream_preview.resolve_preview_subtitle, cleaned, lang
        )
    except HTTPException:
        raise  # 429 from the slot
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not load preview subtitles: {exc}"
        ) from exc

    client = get_preview_client()
    headers = dict(resolved.get("http_headers") or {})

    try:
        resp = await _send_validated(
            client, "GET", resolved["direct_url"], headers, stream=False
        )
    except httpx.HTTPError as exc:
        logger.warning("Upstream subtitle fetch failed: %s", exc)
        raise HTTPException(
            status_code=502, detail=f"Upstream subtitle failed: {exc}"
        ) from exc

    if resp.status_code in (401, 403, 404):
        logger.info(
            "Refreshing preview subtitle url=%s lang=%s status=%s",
            cleaned[:80],
            lang,
            resp.status_code,
        )
        try:
            resolved = await _in_ytdlp_thread(
                request,
                stream_preview.resolve_preview_subtitle,
                cleaned,
                lang,
                force=True,
            )
        except HTTPException:
            raise
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Could not refresh preview subtitles: {exc}",
            ) from exc
        headers = dict(resolved.get("http_headers") or {})
        try:
            resp = await _send_validated(
                client, "GET", resolved["direct_url"], headers, stream=False
            )
        except httpx.HTTPError as exc:
            logger.warning("Upstream subtitle retry failed: %s", exc)
            raise HTTPException(
                status_code=502, detail=f"Upstream subtitle failed: {exc}"
            ) from exc

    if resp.status_code >= 400:
        logger.warning(
            "Upstream subtitle returned %s: %r",
            resp.status_code,
            resp.content[:200],
        )
        raise HTTPException(
            status_code=502,
            detail=f"Upstream returned {resp.status_code}",
        )

    body = resp.content
    # Strip a UTF-8 BOM if present so the WEBVTT check is reliable.
    if body.startswith(b"\xef\xbb\xbf"):
        body = body[3:]
    if not body.lstrip().startswith(b"WEBVTT"):
        logger.warning("Upstream subtitle was not WEBVTT (prefix=%r)", body[:40])
        raise HTTPException(status_code=502, detail="Upstream subtitle was not WEBVTT")

    return Response(
        content=body,
        media_type="text/vtt",
        headers={"Cache-Control": _CACHE_CONTROL},
    )


# One handler serves both verbs. HEAD stays out of the schema so the OpenAPI
# document has a single operation id (api_route would emit it twice and warn).
@router.head("/manifest", include_in_schema=False, dependencies=[Depends(ytdlp_slot)])
@router.get("/manifest", dependencies=[Depends(ytdlp_slot)])
def preview_manifest(request: Request, url: str = Query(...)):
    """DASH MPD for adaptive high-res preview streaming."""
    cleaned = _require_video_url(url)
    try:
        session = stream_preview.resolve_preview_manifest(cleaned)
        xml = stream_preview.build_dash_manifest(session)
    except Exception as exc:
        logger.exception("preview manifest failed for %r", cleaned)
        raise HTTPException(
            status_code=400,
            detail=http_detail_for_error(
                exc, prefix="Could not build preview manifest", url=cleaned
            ),
        ) from exc

    headers = {"Cache-Control": "no-store"}
    if request.method == "HEAD":
        # Shaka / browsers probe with HEAD; body is omitted by the server.
        headers["Content-Length"] = str(len(xml.encode("utf-8")))
        return Response(
            status_code=200,
            media_type="application/dash+xml",
            headers=headers,
        )

    return Response(
        content=xml,
        media_type="application/dash+xml",
        headers=headers,
    )


@router.get("/media")
async def preview_media(
    request: Request,
    token: str = Query(...),
    itag: str = Query(...),
):
    """Proxy an adaptive format segment/byte-range by opaque token."""
    if not token.strip() or not itag.strip():
        raise HTTPException(status_code=400, detail="token and itag are required")
    try:
        resolved = await _in_ytdlp_thread(
            request, stream_preview.lookup_preview_media, token, itag
        )
    except HTTPException:
        raise  # 429 from the slot
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except stream_preview.PreviewRefreshError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not open preview media: {exc}"
        ) from exc

    return await _proxy_upstream(request, resolved, allow_refresh=(token, itag))


@router.head("/media")
async def preview_media_head(
    request: Request,
    token: str = Query(...),
    itag: str = Query(...),
):
    if not token.strip() or not itag.strip():
        raise HTTPException(status_code=400, detail="token and itag are required")
    try:
        resolved = await _in_ytdlp_thread(
            request, stream_preview.lookup_preview_media, token, itag
        )
    except HTTPException:
        raise  # 429 from the slot
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except stream_preview.PreviewRefreshError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not open preview media: {exc}"
        ) from exc

    return await _head_upstream(request, resolved, allow_refresh=(token, itag))


@router.get("/stream")
async def preview_stream(request: Request, url: str = Query(...)):
    """Legacy progressive (<=720p) proxy — kept as fallback."""
    cleaned = await run_in_threadpool(_require_video_url, url)
    try:
        resolved = await _in_ytdlp_thread(
            request, stream_preview.resolve_preview_stream, cleaned
        )
    except HTTPException:
        raise  # 429 from the slot
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not open preview stream: {exc}"
        ) from exc

    return await _proxy_upstream(request, resolved, stream_url=cleaned)
