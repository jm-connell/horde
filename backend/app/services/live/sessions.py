"""Live HLS sessions: one per broadcast being watched, shared by every viewer.

The browser plays ``/api/live/<id>/master.m3u8``; every playlist and segment it
asks for is answered from here. What keeps a stream up for hours:

* **Stable URLs.** The player only ever sees Horde URLs. When YouTube's URLs
  expire (about 6 hours) or start answering 403, the session re-extracts them
  (``reresolve``, one at a time) and the next playlist refresh carries on. The
  player never notices. URLs are also refreshed ahead of their ``expire`` time.
* **Stall watchdog.** A playlist whose newest segment has not moved for a while
  (a dead CDN edge) triggers the same re-extraction.
* **Shared upstream fetches.** A playlist is fetched from YouTube at most once
  per half target duration, whatever the number of viewers.
* **DVR window.** YouTube keeps a broadcast's segments addressable by sequence
  number. After the first playlist the session probes how far back that goes and
  lists up to ``dvr_window_sec`` of earlier segments, built from the newest
  segment URL (``hls.segment_template``). When probing fails the window is what
  the session has seen itself.
* **Clean ending.** When the broadcast ends the playlist gets ``EXT-X-ENDLIST``
  and the player stops at the end instead of erroring.

Network access is injected (``Fetcher`` / ``Resolver``) so the logic is tested
without YouTube.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from . import hls

logger = logging.getLogger(__name__)

Fetcher = Callable[[str, dict[str, str], bool], Awaitable[httpx.Response]]
#: ``(source_url, force)`` -> a yt-dlp info dict
Resolver = Callable[[str, bool], Awaitable[dict[str, Any]]]
Clock = Callable[[], float]

_KEY_RE = re.compile(r"[^A-Za-z0-9_-]")
_EXPIRE_PATH_RE = re.compile(r"/expire/(\d+)(?=/|$)")
_RERESOLVE_DEBOUNCE_SEC = 8.0
_EXPIRY_MARGIN_SEC = 20 * 60
_REPROBE_SEC = 30 * 60
_STALE_PLAYLIST_GRACE_SEC = 30.0
_MAX_PLAYLIST_BYTES = 4 * 1024 * 1024
_FIRST_PROBE_SEC = 10.0
#: A full DVR window slides in steps of this many segments, not one per
#: playlist, so variants rendered a segment apart still share their start.
_WINDOW_SLACK_SEGMENTS = 30
#: Low-latency broadcasts (1-2 s segments) would make a 4 hour playlist huge.
_MAX_WINDOW_SEGMENTS = 7200
#: An open that just failed is answered from memory for this long, so a player
#: retrying a dead stream does not run yt-dlp on every retry.
_OPEN_FAILURE_TTL_SEC = 15.0
#: Sessions accessed this recently are never evicted to make room.
_ACTIVE_SEC = 60.0


class LiveNotAvailable(Exception):
    """The video is not live (anymore), or has no live HLS stream."""


class LiveUpstreamError(Exception):
    """YouTube answered with an error the session could not recover from."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class LiveSegmentMissing(Exception):
    """The segment is outside what the broadcast still serves."""


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def is_live_info(info: dict[str, Any]) -> bool:
    return info.get("is_live") is True or info.get("live_status") == "is_live"


@dataclass
class _Upstream:
    url: str
    headers: dict[str, str]
    info: hls.VariantInfo
    #: An audio-only rendition (packed AAC segments) played beside the video.
    audio: bool = False


def _hls_formats(info: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        fmt
        for fmt in info.get("formats") or []
        if isinstance(fmt, dict)
        and fmt.get("url")
        and str(fmt.get("protocol") or "").startswith("m3u8")
    ]


def _has(codec: Any) -> bool:
    return bool(codec) and str(codec) != "none"


def _upstream(fmt: dict[str, Any], info: hls.VariantInfo, *, audio: bool) -> _Upstream:
    return _Upstream(
        url=str(fmt["url"]),
        headers={str(k): str(v) for k, v in (fmt.get("http_headers") or {}).items()},
        info=info,
        audio=audio,
    )


def _key(fmt: dict[str, Any], fallback: int) -> str:
    return _KEY_RE.sub("_", str(fmt.get("format_id") or fallback)) or str(fallback)


def _variants_from_info(info: dict[str, Any]) -> dict[str, _Upstream]:
    """The HLS formats of a live broadcast, one video variant per height.

    YouTube used to serve muxed (audio + video) TS variants; many broadcasts now
    come as video-only TS variants plus audio-only packed-AAC ones. Muxed
    variants are used when there are any, otherwise the video-only ones with
    the best audio-only format as their shared audio rendition.
    """
    if not is_live_info(info):
        raise LiveNotAvailable("This video is not live")
    formats = _hls_formats(info)
    muxed = [f for f in formats if _has(f.get("vcodec")) and _has(f.get("acodec"))]
    audio_fmt: dict[str, Any] | None = None
    video = muxed
    if not muxed:
        video = [
            f for f in formats if _has(f.get("vcodec")) and not _has(f.get("acodec"))
        ]
        audio_only = [f for f in formats if not _has(f.get("vcodec"))]
        if video and audio_only:
            # tbr is often missing on the audio formats; the higher itag (234
            # over 233) is the higher bitrate.
            audio_fmt = max(
                audio_only,
                key=lambda f: (
                    float(f.get("tbr") or 0),
                    int(f["format_id"]) if str(f.get("format_id")).isdigit() else 0,
                ),
            )
        else:
            video = []
    by_height: dict[int, tuple[float, dict[str, Any]]] = {}
    for fmt in video:
        height = int(fmt.get("height") or 0)
        tbr = float(fmt.get("tbr") or 0)
        current = by_height.get(height)
        if current is None or tbr > current[0]:
            by_height[height] = (tbr, fmt)
    out: dict[str, _Upstream] = {}
    for height, (tbr, fmt) in sorted(by_height.items()):
        key = _key(fmt, height)
        codecs = ",".join(
            c
            for c in (str(fmt.get("vcodec") or ""), str(fmt.get("acodec") or ""))
            if c and c != "none" and "." in c
        )
        fps = fmt.get("fps")
        out[key] = _upstream(
            fmt,
            hls.VariantInfo(
                key=key,
                bandwidth=int(tbr * 1000) if tbr else 500_000 + height * 4000,
                width=int(fmt["width"]) if fmt.get("width") else None,
                height=height or None,
                fps=float(fps) if fps else None,
                codecs=codecs or None,
            ),
            audio=False,
        )
    if not out:
        raise LiveNotAvailable("No live HLS stream is available for this video")
    if audio_fmt is not None:
        key = _key(audio_fmt, 0)
        acodec = str(audio_fmt.get("acodec") or "")
        tbr = float(audio_fmt.get("tbr") or 0)
        out[key] = _upstream(
            audio_fmt,
            hls.VariantInfo(
                key=key,
                bandwidth=int(tbr * 1000) if tbr else 128_000,
                width=None,
                height=None,
                fps=None,
                codecs=acodec if "." in acodec else "mp4a.40.2",
            ),
            audio=True,
        )
    return out


@dataclass(frozen=True)
class ClipSource:
    """Where to read a live broadcast's segments from, for cutting a clip."""

    video_url: str
    video_headers: dict[str, str]
    audio_url: str | None = None
    audio_headers: dict[str, str] = field(default_factory=dict)


def clip_source(info: dict[str, Any]) -> ClipSource:
    """The tallest video variant (and its audio rendition) of a live broadcast.

    Raises LiveNotAvailable when the video is not live or has no HLS stream.
    """
    upstreams = list(_variants_from_info(info).values())
    video = max(
        (u for u in upstreams if not u.audio),
        key=lambda u: (u.info.height or 0, u.info.bandwidth),
    )
    audio = next((u for u in upstreams if u.audio), None)
    return ClipSource(
        video_url=video.url,
        video_headers=video.headers,
        audio_url=audio.url if audio else None,
        audio_headers=audio.headers if audio else {},
    )


def url_expiry(url: str) -> float | None:
    """The ``expire`` timestamp a googlevideo URL carries (path or query)."""
    match = _EXPIRE_PATH_RE.search(url)
    if match:
        return float(match.group(1))
    values = parse_qs(urlparse(url).query).get("expire")
    if values and values[0].isdigit():
        return float(values[0])
    return None


@dataclass
class _KnownSegment:
    segment: hls.Segment
    generation: int


@dataclass
class _Variant:
    upstream: _Upstream
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    known: dict[int, _KnownSegment] = field(default_factory=dict)
    template: str | None = None
    head_sq: int | None = None
    target_duration: float = 0.0
    fetched_at: float = 0.0
    advanced_at: float = 0.0
    rendered: str | None = None
    #: Consecutive stall refreshes without the head moving (backs the watchdog off).
    stalls: int = 0


class LiveSession:
    """One broadcast. Create with ``LiveSession.from_info``; methods are async."""

    def __init__(
        self,
        video_id: str,
        upstreams: dict[str, _Upstream],
        *,
        fetcher: Fetcher,
        resolver: Resolver,
        dvr_window_sec: float,
        clock: Clock = time.time,
        title: str | None = None,
    ) -> None:
        self.video_id = video_id
        self.title = title
        self.source_url = watch_url(video_id)
        self.variants = {k: _Variant(upstream=u) for k, u in upstreams.items()}
        self.ended = False
        self.dvr_floor: int | None = None
        #: The lowest MEDIA-SEQUENCE any playlist may start at. HLS players map
        #: sequence numbers to time from the first playlist they load, so a later
        #: playlist must never start earlier (RFC 8216 6.2.2). It is shared: with
        #: a separate audio rendition the player reads two playlists at once, and
        #: they must start at the same segment for the timelines to line up.
        self.start_floor: int | None = None
        self.template_ok: bool | None = None
        self.generation = 0
        self._fetch = fetcher
        self._resolve = resolver
        self._clock = clock
        self._dvr_window_sec = max(0.0, dvr_window_sec)
        self._resolve_lock = asyncio.Lock()
        self._resolved_at = clock()
        self._probed_at: float | None = None
        #: The first DVR probe; every variant's first playlist waits for it.
        self._first_probe: asyncio.Future[None] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self.last_access = clock()

    @classmethod
    def from_info(
        cls,
        video_id: str,
        info: dict[str, Any],
        *,
        fetcher: Fetcher,
        resolver: Resolver,
        dvr_window_sec: float,
        clock: Clock = time.time,
    ) -> LiveSession:
        title = info.get("title")
        return cls(
            video_id,
            _variants_from_info(info),
            fetcher=fetcher,
            resolver=resolver,
            dvr_window_sec=dvr_window_sec,
            clock=clock,
            title=str(title) if title else None,
        )

    # --- bookkeeping -------------------------------------------------------

    def touch(self) -> None:
        self.last_access = self._clock()

    def _spawn(self, coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)

    def _task_done(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.warning(
                "live background task failed for %s",
                self.video_id,
                exc_info=task.exception(),
            )

    def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        self._tasks.clear()

    def _window_segments(self, target: float) -> int:
        count = int(self._dvr_window_sec / max(1.0, target or 5.0))
        return min(count, _MAX_WINDOW_SEGMENTS)

    def broadcast_seconds(self, behind_live_sec: float) -> float | None:
        """Seconds from the start of the broadcast of a playhead this far behind live.

        YouTube numbers a broadcast's segments from 0, so segment ``sq`` starts
        ``sq * target`` seconds in. The player's live edge sits three target
        durations before the end of the newest segment (the HLS default hold-back
        Shaka uses). None until a playlist has been read.
        """
        heads = [
            (v.head_sq, v.target_duration)
            for v in self.variants.values()
            if not v.upstream.audio and v.head_sq is not None and v.target_duration
        ]
        if not heads:
            return None
        head, target = max(heads)
        live_edge = (head + 1) * target - 3 * target
        return max(0.0, live_edge - max(0.0, behind_live_sec))

    # --- playlists ---------------------------------------------------------

    def master(self) -> str:
        self.touch()
        video = [
            v.upstream.info for v in self.variants.values() if not v.upstream.audio
        ]
        audio = next(
            (v.upstream.info for v in self.variants.values() if v.upstream.audio),
            None,
        )
        return hls.render_master(video, audio)

    async def media(self, key: str) -> str:
        """The media playlist for one variant. Raises KeyError for an unknown key."""
        variant = self.variants[key]
        self.touch()
        async with variant.lock:
            now = self._clock()
            fresh_for = max(1.0, min(variant.target_duration or 2.0, 6.0) / 2)
            if variant.rendered is not None and now - variant.fetched_at < fresh_for:
                return variant.rendered
            if self.ended and variant.rendered is not None:
                return variant.rendered
            try:
                playlist = await self._fetch_playlist(variant)
            except LiveUpstreamError, httpx.HTTPError:
                if (
                    variant.rendered is not None
                    and now - variant.fetched_at < _STALE_PLAYLIST_GRACE_SEC
                ):
                    # Serve the last good one; the player retries the refresh.
                    logger.warning(
                        "live playlist refresh failed for %s/%s; serving the last one",
                        self.video_id,
                        key,
                        exc_info=True,
                    )
                    return variant.rendered
                raise
            if playlist is not None:
                self._ingest(variant, playlist, now)
            if self._probed_at is None and self._should_probe(now) and variant.template:
                self._probed_at = now
                self._first_probe = asyncio.ensure_future(self._probe_dvr(variant))
                self._tasks.add(self._first_probe)
                self._first_probe.add_done_callback(self._task_done)
            if self._first_probe is not None and not self._first_probe.done():
                # The first playlists must already carry the DVR window: adding
                # earlier segments later would move MEDIA-SEQUENCE backwards.
                try:
                    await asyncio.wait_for(
                        asyncio.shield(self._first_probe), _FIRST_PROBE_SEC
                    )
                except TimeoutError:
                    # Left running (other variants may be waiting on it too);
                    # the shared start floor keeps later playlists aligned.
                    logger.warning("live stream %s: DVR probe timed out", self.video_id)
            self._maybe_refresh_urls(variant, now)
            variant.rendered = self._render(variant)
            variant.fetched_at = now
            return variant.rendered

    async def _fetch_playlist(self, variant: _Variant) -> hls.MediaPlaylist | None:
        """Fetch and parse the upstream playlist; None once the broadcast ended."""
        for attempt in range(2):
            resp = await self._fetch(
                variant.upstream.url, variant.upstream.headers, False
            )
            status = resp.status_code
            if status < 400:
                body = resp.content[:_MAX_PLAYLIST_BYTES]
                return hls.parse_media_playlist(
                    body.decode("utf-8", errors="replace"), str(resp.url)
                )
            if status in (401, 403, 404, 410) and attempt == 0:
                still_live = await self.reresolve(reason=f"playlist {status}")
                if not still_live:
                    return None
                continue
            raise LiveUpstreamError(f"YouTube answered {status}", status=status)
        return None

    def _ingest(
        self, variant: _Variant, playlist: hls.MediaPlaylist, now: float
    ) -> None:
        if playlist.target_duration:
            variant.target_duration = playlist.target_duration
        for seg in playlist.segments:
            variant.known[seg.sq] = _KnownSegment(seg, self.generation)
        head = playlist.head_sq
        if head is not None and (variant.head_sq is None or head > variant.head_sq):
            variant.head_sq = head
            variant.advanced_at = now
            variant.stalls = 0
        if playlist.segments:
            template = hls.segment_template(playlist.segments[-1].uri)
            if template is not None:
                variant.template = template
        if playlist.ended:
            self.ended = True
        if variant.head_sq is not None:
            floor = variant.head_sq - self._window_segments(variant.target_duration) - 8
            for sq in [sq for sq in variant.known if sq < floor]:
                del variant.known[sq]
        if not variant.advanced_at:
            variant.advanced_at = now
        # A broadcast whose encoder dropped can sit still for a long time: back
        # off (30 s, 60 s, ... up to 8 minutes) instead of re-extracting forever.
        base = max(30.0, 6 * (variant.target_duration or 5.0))
        stall_after = base * 2 ** min(variant.stalls, 4)
        if not self.ended and now - variant.advanced_at > stall_after:
            variant.advanced_at = now  # one re-extraction per stall period
            variant.stalls += 1
            self._spawn(self.reresolve(reason="playlist stalled"))
        if (
            self._probed_at is not None
            and self._should_probe(now)
            and variant.template is not None
        ):
            self._probed_at = now
            self._spawn(self._probe_dvr(variant))

    def _maybe_refresh_urls(self, variant: _Variant, now: float) -> None:
        expires = url_expiry(variant.upstream.url)
        if (
            expires is not None
            and not self.ended
            and expires - now < _EXPIRY_MARGIN_SEC
            and now - self._resolved_at > _RERESOLVE_DEBOUNCE_SEC
        ):
            self._spawn(self.reresolve(reason="URLs expiring"))

    def _render(self, variant: _Variant) -> str:
        target = variant.target_duration or 5.0
        head = variant.head_sq
        entries: list[tuple[int, float]] = []
        if head is not None:
            floor = (
                min(self.start_floor, head) if self.start_floor is not None else None
            )
            if self.template_ok and self.dvr_floor is not None and variant.template:
                window = self._window_segments(target)
                if floor is None or head - floor > window + _WINDOW_SLACK_SEGMENTS:
                    floor = max(floor or 0, head - window)
                start = max(self.dvr_floor, floor)
                entries = [
                    (
                        sq,
                        variant.known[sq].segment.duration
                        if sq in variant.known
                        else target,
                    )
                    for sq in range(start, head + 1)
                ]
            else:
                sq = head
                while sq in variant.known and (floor is None or sq >= floor):
                    entries.append((sq, variant.known[sq].segment.duration))
                    sq -= 1
                entries.reverse()
        if entries:
            self.start_floor = max(self.start_floor or 0, entries[0][0])
        ext = "aac" if variant.upstream.audio else "ts"
        return hls.render_media(
            entries,
            segment_uri=f"../seg/{variant.upstream.info.key}/{{sq}}.{ext}",
            ended=self.ended,
            target_duration=target,
        )

    # --- segments ----------------------------------------------------------

    def _segment_url(self, variant: _Variant, sq: int) -> str | None:
        known = variant.known.get(sq)
        if known is not None and known.generation == self.generation:
            return known.segment.uri
        if variant.template is not None:
            return hls.fill_template(variant.template, sq)
        return known.segment.uri if known is not None else None

    async def segment(self, key: str, sq: int) -> httpx.Response:
        """An open (streaming) upstream response for one segment; caller closes it.

        Raises KeyError (unknown variant), LiveSegmentMissing or LiveUpstreamError.
        """
        variant = self.variants[key]
        self.touch()
        for attempt in range(2):
            url = self._segment_url(variant, sq)
            if url is None:
                raise LiveSegmentMissing(f"segment {sq} is not available")
            resp = await self._fetch(url, variant.upstream.headers, True)
            status = resp.status_code
            if status < 400:
                return resp
            await resp.aclose()
            if (
                status in (401, 403)
                and attempt == 0
                and await self.reresolve(reason=f"segment {status}")
            ):
                # Segment URLs (and the template) come from the playlist, so
                # read it again with the fresh playlist URL before retrying.
                await self._refresh_playlist(variant)
                continue
            if status in (404, 410):
                if (
                    self.dvr_floor is not None
                    and variant.head_sq is not None
                    and sq < variant.head_sq - 10
                ):
                    # YouTube's own DVR window slid past it: stop listing it.
                    self.dvr_floor = max(self.dvr_floor, sq + 1)
                    variant.rendered = None
                raise LiveSegmentMissing(f"segment {sq} is gone ({status})")
            raise LiveUpstreamError(f"YouTube answered {status}", status=status)
        raise LiveUpstreamError("segment unavailable after refreshing the stream")

    async def _refresh_playlist(self, variant: _Variant) -> None:
        async with variant.lock:
            try:
                playlist = await self._fetch_playlist(variant)
            except LiveUpstreamError, httpx.HTTPError:
                logger.warning(
                    "live playlist refresh after a segment 403 failed for %s",
                    self.video_id,
                    exc_info=True,
                )
                return
            now = self._clock()
            if playlist is not None:
                self._ingest(variant, playlist, now)
            variant.rendered = self._render(variant)
            variant.fetched_at = now

    # --- recovery ----------------------------------------------------------

    async def reresolve(self, *, reason: str) -> bool:
        """Re-extract the stream URLs (one at a time, debounced). False once ended."""
        async with self._resolve_lock:
            if self.ended:
                return False
            now = self._clock()
            if now - self._resolved_at < _RERESOLVE_DEBOUNCE_SEC:
                return True
            logger.info("refreshing live stream %s (%s)", self.video_id, reason)
            self._resolved_at = now
            try:
                info = await self._resolve(self.source_url, True)
            except Exception:
                # Transient (rate limit, network): keep the old URLs, try again later.
                logger.warning(
                    "could not refresh live stream %s", self.video_id, exc_info=True
                )
                return True
            if not is_live_info(info):
                logger.info("live stream %s has ended", self.video_id)
                self.ended = True
                for variant in self.variants.values():
                    variant.rendered = None
                return False
            try:
                fresh = _variants_from_info(info)
            except LiveNotAvailable:
                # Live but no HLS formats this time (a yt-dlp or PO-token blip):
                # keep the old URLs and try again on the next trigger.
                logger.warning(
                    "live stream %s: refresh returned no HLS formats", self.video_id
                )
                return True
            self.generation += 1
            for key, upstream in fresh.items():
                existing = self.variants.get(key)
                if existing is None:
                    self.variants[key] = _Variant(upstream=upstream)
                else:
                    existing.upstream = upstream
                    existing.rendered = None
            return True

    def _should_probe(self, now: float) -> bool:
        if self._dvr_window_sec <= 0 or self.ended:
            return False
        return self._probed_at is None or now - self._probed_at > _REPROBE_SEC

    async def _segment_exists(self, variant: _Variant, sq: int) -> bool:
        if variant.template is None:
            return False
        try:
            resp = await self._fetch(
                hls.fill_template(variant.template, sq), variant.upstream.headers, True
            )
        except httpx.HTTPError:
            logger.debug("live DVR probe of sq %s failed", sq, exc_info=True)
            return False
        ok = resp.status_code < 400
        await resp.aclose()
        return ok

    async def _probe_dvr(self, variant: _Variant) -> None:
        """Find the earliest segment the broadcast still serves (within the window)."""
        head = variant.head_sq
        if head is None or variant.template is None:
            return
        window = self._window_segments(variant.target_duration)
        offsets = sorted(
            {int(window / d) for d in (1, 2, 4, 8, 16, 48) if int(window / d) > 0},
            reverse=True,
        )
        candidates: list[int] = []
        for off in offsets:
            sq = max(0, head - off)
            if sq not in candidates and sq < head:
                candidates.append(sq)
        for sq in candidates:
            if await self._segment_exists(variant, sq):
                self.template_ok = True
                self.dvr_floor = sq if sq > 0 else 0
                for v in self.variants.values():
                    v.rendered = None
                logger.info(
                    "live stream %s: DVR reaches back %s segments",
                    self.video_id,
                    head - sq,
                )
                return
        if self.template_ok is None:
            self.template_ok = False
        logger.info("live stream %s: no DVR beyond the playlist window", self.video_id)


class LiveSessionManager:
    """The open sessions of one app (held on ``AppContext.live``)."""

    def __init__(
        self,
        *,
        dvr_window_sec: float,
        max_sessions: int = 6,
        idle_sec: float = 600.0,
        clock: Clock = time.time,
    ) -> None:
        self.dvr_window_sec = dvr_window_sec
        self.max_sessions = max(1, max_sessions)
        self.idle_sec = idle_sec
        self._clock = clock
        self._sessions: dict[str, LiveSession] = {}
        self._opening: dict[str, asyncio.Lock] = {}
        self._failed: dict[str, tuple[float, Exception]] = {}

    def sessions(self) -> list[LiveSession]:
        return list(self._sessions.values())

    def get(self, video_id: str) -> LiveSession | None:
        """The open session for ``video_id`` (somebody is watching it), if any."""
        return self._sessions.get(video_id)

    def _evict(self) -> None:
        now = self._clock()
        for vid, session in list(self._sessions.items()):
            if now - session.last_access > self.idle_sec:
                session.close()
                del self._sessions[vid]
        # Over the limit, drop the least recently used *inactive* sessions only;
        # somebody still watching keeps theirs.
        while len(self._sessions) > self.max_sessions:
            inactive = [
                k
                for k, v in self._sessions.items()
                if now - v.last_access > _ACTIVE_SEC
            ]
            if not inactive:
                break
            vid = min(inactive, key=lambda k: self._sessions[k].last_access)
            self._sessions.pop(vid).close()
        for vid in [
            k
            for k, (at, _e) in self._failed.items()
            if now - at > _OPEN_FAILURE_TTL_SEC
        ]:
            del self._failed[vid]

    async def open(
        self, video_id: str, *, fetcher: Fetcher, resolver: Resolver
    ) -> LiveSession:
        """The session for ``video_id``, extracting the stream on first use.

        Raises LiveNotAvailable when the video is not live.
        """
        self._evict()
        session = self._sessions.get(video_id)
        if session is not None:
            session.touch()
            return session
        failed = self._failed.get(video_id)
        if failed is not None:
            raise failed[1]
        lock = self._opening.setdefault(video_id, asyncio.Lock())
        try:
            async with lock:
                session = self._sessions.get(video_id)
                if session is None:
                    failed = self._failed.get(video_id)
                    if failed is not None:
                        raise failed[1]
                    try:
                        info = await resolver(watch_url(video_id), False)
                        session = LiveSession.from_info(
                            video_id,
                            info,
                            fetcher=fetcher,
                            resolver=resolver,
                            dvr_window_sec=self.dvr_window_sec,
                            clock=self._clock,
                        )
                    except Exception as exc:
                        self._failed[video_id] = (self._clock(), exc)
                        raise
                    self._sessions[video_id] = session
                    self._evict()
        finally:
            if not lock.locked():
                self._opening.pop(video_id, None)
        return session

    def close_all(self) -> None:
        for session in self._sessions.values():
            session.close()
        self._sessions.clear()
