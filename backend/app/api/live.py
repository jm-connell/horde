"""Live streams: who is live among the user's follows, and the HLS proxy.

The player loads ``/api/live/{video_id}/master.m3u8``. Variant playlists
(``v/{key}.m3u8``) and segments (``seg/{key}/{sq}.ts``) are relative to it and
answered by the video's ``LiveSession`` (``services/live/sessions.py``), which
keeps the upstream YouTube URLs fresh and adds the DVR window.
"""

from __future__ import annotations

import gzip
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Path, Request
from fastapi.responses import Response, StreamingResponse
from sqlmodel import Session
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from ..auth import current_user
from ..config import LIVE_POLL_SEC
from ..context import get_ctx, get_session
from ..errors import CodedHTTPException
from ..openapi_responses import RAW, media_response
from ..schemas import LiveChannelRead, LiveListResponse
from ..services import follows, stream_preview
from ..services.auth.accounts import AuthUser
from ..services.live.sessions import (
    LiveNotAvailable,
    LiveSegmentMissing,
    LiveSession,
    LiveUpstreamError,
)
from .preview import _send_validated, get_preview_client

router = APIRouter(prefix="/api/live", tags=["live"])
logger = logging.getLogger(__name__)

HLS_PLAYLIST = media_response(
    "application/vnd.apple.mpegurl", description="HLS playlist"
)
TS_SEGMENT = media_response("video/mp2t", description="MPEG-TS media segment")
AAC_SEGMENT = media_response("audio/aac", description="Packed AAC audio segment")
_PLAYLIST_TYPE = "application/vnd.apple.mpegurl"
_CHUNK = 256 * 1024

VideoId = Path(..., pattern=r"^[A-Za-z0-9_-]{11}$")
VariantKey = Path(..., pattern=r"^[A-Za-z0-9_-]{1,40}$")


@router.get("", response_model=LiveListResponse)
def live_now(
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Followed channels that are live right now (from the background checks)."""
    followed = follows.followed_urls(session, user.id)
    directory = get_ctx(request).live.directory
    items: list[LiveChannelRead] = []
    seen: set[str] = set()
    for state in directory.live(followed):
        b = state.broadcast
        if b is None or b.video_id in seen:
            continue
        seen.add(b.video_id)
        items.append(
            LiveChannelRead(
                channel_url=state.channel_url,
                channel_name=state.channel_name,
                video_id=b.video_id,
                title=b.title,
                game=b.game,
                viewers=b.viewers,
                started_at=b.started_at,
                thumbnail_url=b.thumbnail_url,
                watch_url=f"https://www.youtube.com/watch?v={b.video_id}",
            )
        )
    return LiveListResponse(items=items, enabled=LIVE_POLL_SEC > 0)


# --- HLS proxy -----------------------------------------------------------------


async def _fetch(url: str, headers: dict[str, str], stream: bool) -> httpx.Response:
    return await _send_validated(
        get_preview_client(), "GET", url, headers, stream=stream
    )


def _resolver(request: Request):
    app = request.app

    async def resolve(url: str, force: bool) -> dict[str, Any]:
        async with app.state.ytdlp_slots.slot():
            return await run_in_threadpool(
                stream_preview._extract_preview_info, url, force=force
            )

    return resolve


async def _session(request: Request, video_id: str) -> LiveSession:
    manager = get_ctx(request).live.sessions
    try:
        return await manager.open(video_id, fetcher=_fetch, resolver=_resolver(request))
    except LiveNotAvailable as exc:
        raise CodedHTTPException(409, str(exc), "not_live") from exc
    except CodedHTTPException:
        raise
    except Exception as exc:
        logger.warning("could not open live stream %s", video_id, exc_info=True)
        raise CodedHTTPException(
            502, "Could not load the live stream", "live_upstream"
        ) from exc


def _playlist(request: Request, body: str) -> Response:
    """A playlist, gzipped when the client accepts it.

    A DVR playlist lists thousands of segments and is re-read every few
    seconds; its repetitive lines shrink about tenfold.
    """
    headers = {"Cache-Control": "no-store", "Vary": "Accept-Encoding"}
    data = body.encode()
    if len(data) > 2048 and "gzip" in request.headers.get("accept-encoding", ""):
        data = gzip.compress(data, compresslevel=5)
        headers["Content-Encoding"] = "gzip"
    return Response(content=data, media_type=_PLAYLIST_TYPE, headers=headers)


@router.get("/{video_id}/master.m3u8", response_class=RAW, responses=HLS_PLAYLIST)
async def live_master(request: Request, video_id: str = VideoId):
    session = await _session(request, video_id)
    return _playlist(request, session.master())


@router.get("/{video_id}/v/{key}.m3u8", response_class=RAW, responses=HLS_PLAYLIST)
async def live_media_playlist(
    request: Request, video_id: str = VideoId, key: str = VariantKey
):
    session = await _session(request, video_id)
    try:
        return _playlist(request, await session.media(key))
    except KeyError as exc:
        raise CodedHTTPException(404, "Unknown stream variant", "not_found") from exc
    except (LiveUpstreamError, httpx.HTTPError) as exc:
        logger.warning("live playlist %s/%s failed: %s", video_id, key, exc)
        raise CodedHTTPException(
            502, "The live stream did not answer", "live_upstream"
        ) from exc


async def _close(resp: httpx.Response) -> None:
    try:
        await resp.aclose()
    except Exception:
        logger.debug("closing a live segment response failed", exc_info=True)


async def _segment(
    request: Request, video_id: str, key: str, sq: int, media_type: str
) -> StreamingResponse:
    session = await _session(request, video_id)
    try:
        upstream = await session.segment(key, sq)
    except KeyError as exc:
        raise CodedHTTPException(404, "Unknown stream variant", "not_found") from exc
    except LiveSegmentMissing as exc:
        raise CodedHTTPException(404, str(exc), "segment_gone") from exc
    except (LiveUpstreamError, httpx.HTTPError) as exc:
        logger.warning("live segment %s/%s/%s failed: %s", video_id, key, sq, exc)
        raise CodedHTTPException(
            502, "The live stream did not answer", "live_upstream"
        ) from exc

    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=_CHUNK):
                if chunk:
                    yield chunk
        finally:
            await _close(upstream)

    return StreamingResponse(
        body(),
        media_type=media_type,
        # A segment number always names the same media.
        headers={"Cache-Control": "private, max-age=3600"},
        background=BackgroundTask(_close, upstream),
    )


@router.get("/{video_id}/seg/{key}/{sq}.ts", response_class=RAW, responses=TS_SEGMENT)
async def live_segment(
    request: Request,
    video_id: str = VideoId,
    key: str = VariantKey,
    sq: int = Path(..., ge=0),
):
    return await _segment(request, video_id, key, sq, "video/mp2t")


@router.get("/{video_id}/seg/{key}/{sq}.aac", response_class=RAW, responses=AAC_SEGMENT)
async def live_audio_segment(
    request: Request,
    video_id: str = VideoId,
    key: str = VariantKey,
    sq: int = Path(..., ge=0),
):
    """A segment of the separate audio rendition (packed AAC with an ID3 timestamp)."""
    return await _segment(request, video_id, key, sq, "audio/aac")
