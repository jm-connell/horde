"""In-app YouTube stream preview (progressive proxy + adaptive DASH)."""

from __future__ import annotations

import logging
from typing import AsyncIterator, Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlmodel import Session
from starlette.background import BackgroundTask

from ..database import get_session
from ..schemas import StreamPreviewMeta
from ..services import downloader, library
from ..services.url_clean import _youtube_video_id, clean_url

router = APIRouter(prefix="/api/preview", tags=["preview"])
logger = logging.getLogger(__name__)

_CHUNK = 512 * 1024
_CACHE_CONTROL = "private, max-age=1800, immutable"

_preview_client: Optional[httpx.AsyncClient] = None


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
        follow_redirects=True,
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
    return cleaned


async def _open_upstream(
    client: httpx.AsyncClient,
    direct_url: str,
    headers: dict[str, str],
) -> httpx.Response:
    upstream_req = client.build_request("GET", direct_url, headers=headers)
    return await client.send(upstream_req, stream=True)


async def _close_upstream(upstream: Optional[httpx.Response]) -> None:
    if upstream is None:
        return
    try:
        await upstream.aclose()
    except Exception:  # noqa: BLE001
        pass


async def _proxy_upstream(
    request: Request,
    resolved: dict,
    *,
    allow_refresh: Optional[tuple[str, str]] = None,
) -> StreamingResponse:
    """Proxy a CDN media URL with Range support.

    If allow_refresh is (token, itag) and upstream returns 403, refresh once.
    """
    client = get_preview_client()
    upstream_headers = dict(resolved.get("http_headers") or {})
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    upstream: Optional[httpx.Response] = None
    try:
        upstream = await _open_upstream(
            client, resolved["direct_url"], upstream_headers
        )
    except httpx.HTTPError as exc:
        logger.warning("Upstream stream open failed: %s", exc)
        raise HTTPException(
            status_code=502, detail=f"Upstream stream failed: {exc}"
        ) from exc

    # Expired CDN URL — re-resolve once and retry.
    if upstream.status_code in (401, 403) and allow_refresh is not None:
        await _close_upstream(upstream)
        upstream = None
        token, itag = allow_refresh
        logger.info("Refreshing preview media token=%s itag=%s", token[:8], itag)
        try:
            resolved = downloader.lookup_preview_media(
                token, itag, refresh=True
            )
        except downloader.PreviewRefreshError as exc:
            logger.warning("Preview media refresh failed: %s", exc)
            raise HTTPException(
                status_code=503,
                detail=str(exc),
                headers={"Retry-After": str(exc.retry_after)},
            ) from exc
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not refresh preview media: %s", exc)
            raise HTTPException(
                status_code=502,
                detail=f"Could not refresh preview media: {exc}",
            ) from exc
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

    assert upstream is not None

    if upstream.status_code >= 400:
        try:
            detail = (await upstream.aread())[:200]
        except Exception:  # noqa: BLE001
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
        raise HTTPException(
            status_code=502, detail=f"Unexpected status {status}"
        )

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
    allow_refresh: Optional[tuple[str, str]] = None,
) -> Response:
    """HEAD proxy for adaptive media (CORS/preflight and player probes)."""
    client = get_preview_client()
    upstream_headers = dict(resolved.get("http_headers") or {})
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    try:
        resp = await client.head(
            resolved["direct_url"], headers=upstream_headers
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"Upstream HEAD failed: {exc}"
        ) from exc

    if resp.status_code in (401, 403) and allow_refresh is not None:
        token, itag = allow_refresh
        try:
            resolved = downloader.lookup_preview_media(
                token, itag, refresh=True
            )
        except downloader.PreviewRefreshError as exc:
            raise HTTPException(
                status_code=503,
                detail=str(exc),
                headers={"Retry-After": str(exc.retry_after)},
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"Could not refresh preview media: {exc}",
            ) from exc
        upstream_headers = dict(resolved.get("http_headers") or {})
        if range_header:
            upstream_headers["Range"] = range_header
        try:
            resp = await client.head(
                resolved["direct_url"], headers=upstream_headers
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


@router.get("/meta", response_model=StreamPreviewMeta)
def preview_meta(url: str = Query(...), session: Session = Depends(get_session)):
    cleaned = _require_video_url(url)
    try:
        meta = downloader.extract_stream_preview_meta(cleaned)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Could not load preview: {exc}"
        ) from exc

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
    )


@router.get("/manifest")
def preview_manifest(url: str = Query(...)):
    """DASH MPD for adaptive high-res preview streaming."""
    cleaned = _require_video_url(url)
    try:
        session = downloader.resolve_preview_manifest(cleaned)
        xml = downloader.build_dash_manifest(session)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Could not build preview manifest: {exc}"
        ) from exc

    return Response(
        content=xml,
        media_type="application/dash+xml",
        headers={"Cache-Control": "no-store"},
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
        resolved = downloader.lookup_preview_media(token, itag)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except downloader.PreviewRefreshError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Could not open preview media: {exc}"
        ) from exc

    return await _proxy_upstream(
        request, resolved, allow_refresh=(token, itag)
    )


@router.head("/media")
async def preview_media_head(
    request: Request,
    token: str = Query(...),
    itag: str = Query(...),
):
    if not token.strip() or not itag.strip():
        raise HTTPException(status_code=400, detail="token and itag are required")
    try:
        resolved = downloader.lookup_preview_media(token, itag)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except downloader.PreviewRefreshError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Could not open preview media: {exc}"
        ) from exc

    return await _head_upstream(
        request, resolved, allow_refresh=(token, itag)
    )


@router.get("/stream")
async def preview_stream(request: Request, url: str = Query(...)):
    """Legacy progressive (<=720p) proxy — kept as fallback."""
    cleaned = _require_video_url(url)
    try:
        resolved = downloader.resolve_preview_stream(cleaned)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Could not open preview stream: {exc}"
        ) from exc

    return await _proxy_upstream(request, resolved)
