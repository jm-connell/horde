"""In-app YouTube stream preview (progressive proxy)."""

from __future__ import annotations

from typing import Iterator
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from ..database import get_session
from ..schemas import StreamPreviewMeta
from ..services import downloader, library
from ..services.url_clean import _youtube_video_id, clean_url

router = APIRouter(prefix="/api/preview", tags=["preview"])

_CHUNK = 64 * 1024


def _require_video_url(url: str) -> str:
    cleaned = clean_url(url, keep_playlist=False)
    if not cleaned.strip():
        raise HTTPException(status_code=400, detail="URL is required")
    return cleaned


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


@router.get("/stream")
def preview_stream(request: Request, url: str = Query(...)):
    cleaned = _require_video_url(url)
    try:
        resolved = downloader.resolve_preview_stream(cleaned)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Could not open preview stream: {exc}"
        ) from exc

    upstream_headers = dict(resolved.get("http_headers") or {})
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    client = httpx.Client(
        timeout=httpx.Timeout(30.0, read=300.0),
        follow_redirects=True,
    )
    try:
        upstream_req = client.build_request(
            "GET",
            resolved["direct_url"],
            headers=upstream_headers,
        )
        upstream = client.send(upstream_req, stream=True)
    except httpx.HTTPError as exc:
        client.close()
        raise HTTPException(
            status_code=502, detail=f"Upstream stream failed: {exc}"
        ) from exc

    if upstream.status_code >= 400:
        try:
            detail = upstream.read()[:200]
        except Exception:  # noqa: BLE001
            detail = b""
        upstream.close()
        client.close()
        raise HTTPException(
            status_code=502,
            detail=f"Upstream returned {upstream.status_code}: {detail!r}",
        )

    def iter_bytes() -> Iterator[bytes]:
        try:
            for chunk in upstream.iter_bytes(chunk_size=_CHUNK):
                if chunk:
                    yield chunk
        finally:
            upstream.close()
            client.close()

    out_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get(
            "content-type", resolved.get("content_type") or "video/mp4"
        ),
    }
    content_length = upstream.headers.get("content-length")
    if content_length:
        out_headers["Content-Length"] = content_length
    content_range = upstream.headers.get("content-range")
    if content_range:
        out_headers["Content-Range"] = content_range

    # Strip hop-by-hop / problematic headers from leaking.
    status = upstream.status_code
    if status not in (200, 206):
        # Some CDNs return 200 even with Range; still stream.
        if range_header and status == 200:
            status = 200
        elif status >= 300:
            upstream.close()
            client.close()
            raise HTTPException(status_code=502, detail=f"Unexpected status {status}")

    return StreamingResponse(
        iter_bytes(),
        status_code=status,
        headers=out_headers,
        media_type=out_headers["Content-Type"],
    )
