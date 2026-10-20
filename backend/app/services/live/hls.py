"""HLS playlist parsing and rendering for the live proxy (pure functions).

YouTube's live HLS media playlists list absolute ``googlevideo.com`` segment URLs
whose path carries the segment's sequence number (``/sq/<n>/``). The proxy never
hands those to the browser (they are bound to the server's IP and send no CORS
headers). It renders its own playlists instead, with segment URIs that point back
at itself, keyed by sequence number.

Because the sequence number is part of the path, the URL of any earlier segment
can be built from the newest one (``segment_template``). That is what lets the
player scrub back further than the window YouTube's playlist lists: the proxy
lists as many earlier segments as the broadcast keeps (its DVR window), each
fetched through the same template.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from urllib.parse import urljoin

_SQ_PATH_RE = re.compile(r"/sq/(\d+)(?=/|$)")
_SQ_QUERY_RE = re.compile(r"([?&])sq=(\d+)(?=&|$)")
SQ_PLACEHOLDER = "{sq}"


@dataclass(frozen=True)
class Segment:
    sq: int
    duration: float
    uri: str


@dataclass
class MediaPlaylist:
    target_duration: float = 0.0
    media_sequence: int = 0
    segments: list[Segment] = field(default_factory=list)
    ended: bool = False

    @property
    def head_sq(self) -> int | None:
        return self.segments[-1].sq if self.segments else None


def segment_sq(uri: str) -> int | None:
    """The sequence number a YouTube segment URL carries, if any."""
    match = _SQ_PATH_RE.search(uri)
    if match:
        return int(match.group(1))
    match = _SQ_QUERY_RE.search(uri)
    if match:
        return int(match.group(2))
    return None


def segment_template(uri: str) -> str | None:
    """``uri`` with its sequence number replaced by ``{sq}`` (None if it has none).

    Literal braces elsewhere in the URL are escaped so ``str.format`` only fills
    the sequence number.
    """
    escaped = uri.replace("{", "{{").replace("}", "}}")
    if _SQ_PATH_RE.search(escaped):
        return _SQ_PATH_RE.sub("/sq/" + SQ_PLACEHOLDER, escaped, count=1)
    if _SQ_QUERY_RE.search(escaped):
        return _SQ_QUERY_RE.sub(r"\1sq=" + SQ_PLACEHOLDER, escaped, count=1)
    return None


def fill_template(template: str, sq: int) -> str:
    return template.format(sq=sq)


def _float(text: str) -> float | None:
    try:
        value = float(text.strip())
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def parse_media_playlist(text: str, base_url: str) -> MediaPlaylist:
    """Parse a media playlist. Segment URIs are made absolute against ``base_url``.

    A segment's number is the one in its URL when present (YouTube), otherwise
    its position after ``EXT-X-MEDIA-SEQUENCE`` (any other HLS server).
    """
    out = MediaPlaylist()
    pending_duration: float | None = None
    position = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-TARGETDURATION:"):
            out.target_duration = _float(line.split(":", 1)[1]) or 0.0
        elif line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            value = line.split(":", 1)[1].strip()
            out.media_sequence = int(value) if value.isdigit() else 0
        elif line.startswith("#EXTINF:"):
            pending_duration = _float(line.split(":", 1)[1].split(",", 1)[0])
        elif line.startswith("#EXT-X-ENDLIST"):
            out.ended = True
        elif line.startswith("#"):
            continue
        else:
            uri = urljoin(base_url, line)
            sq = segment_sq(uri)
            if sq is None:
                sq = out.media_sequence + position
            duration = pending_duration
            if duration is None or duration <= 0:
                duration = out.target_duration or 5.0
            out.segments.append(Segment(sq=sq, duration=duration, uri=uri))
            pending_duration = None
            position += 1
    if not out.target_duration and out.segments:
        out.target_duration = max(s.duration for s in out.segments)
    return out


@dataclass(frozen=True)
class VariantInfo:
    key: str
    bandwidth: int
    width: int | None
    height: int | None
    fps: float | None
    codecs: str | None


def render_master(variants: list[VariantInfo], audio: VariantInfo | None = None) -> str:
    """A master playlist whose variant URIs are ``v/<key>.m3u8`` (relative).

    ``audio`` is a separate audio-only rendition (YouTube serves split audio and
    video for many broadcasts); every variant then plays it alongside.
    """
    lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"]
    if audio is not None:
        lines.append(
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",'
            f'DEFAULT=YES,AUTOSELECT=YES,URI="v/{audio.key}.m3u8"'
        )
    for v in variants:
        bandwidth = v.bandwidth + (audio.bandwidth if audio is not None else 0)
        attrs = [f"BANDWIDTH={max(1, bandwidth)}"]
        if v.width and v.height:
            attrs.append(f"RESOLUTION={v.width}x{v.height}")
        codecs = ",".join(c for c in (v.codecs, audio.codecs if audio else None) if c)
        if codecs:
            attrs.append(f'CODECS="{codecs}"')
        if v.fps:
            attrs.append(f"FRAME-RATE={v.fps:.3f}")
        if audio is not None:
            attrs.append('AUDIO="audio"')
        lines.append("#EXT-X-STREAM-INF:" + ",".join(attrs))
        lines.append(f"v/{v.key}.m3u8")
    return "\n".join(lines) + "\n"


def render_media(
    entries: list[tuple[int, float]],
    *,
    segment_uri: str,
    ended: bool,
    target_duration: float,
) -> str:
    """A media playlist of contiguous ``(sq, duration)`` entries.

    ``segment_uri`` is a format string with ``{sq}``. HLS numbers segments by
    position after ``EXT-X-MEDIA-SEQUENCE``, so the entries must not have gaps.
    """
    longest = max([target_duration or 5.0, *(d for _sq, d in entries)])
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{max(1, math.ceil(longest))}",
        f"#EXT-X-MEDIA-SEQUENCE:{entries[0][0] if entries else 0}",
    ]
    for sq, duration in entries:
        lines.append(f"#EXTINF:{duration:.3f},")
        lines.append(segment_uri.format(sq=sq))
    if ended:
        lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"
