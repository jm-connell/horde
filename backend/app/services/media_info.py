"""Probe the real codec of a stored file so clients can decide what to play.

The download mode on a job says what we *asked* for; this records what is on
disk (AV1 vs VP9 vs H.264, bit depth, HDR) plus an RFC 6381 codec string the
browser can hand to ``navigator.mediaCapabilities.decodingInfo``.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from ..models import Video, utcnow
from .ffmpeg_bin import ffprobe_bin

logger = logging.getLogger(__name__)

_FAMILY = {
    "av1": "av1",
    "av01": "av1",
    "libdav1d": "av1",
    "vp9": "vp9",
    "vp09": "vp9",
    "vp8": "vp8",
    "h264": "h264",
    "avc": "h264",
    "avc1": "h264",
    "hevc": "hevc",
    "h265": "hevc",
    "hvc1": "hevc",
    "hev1": "hevc",
}

_HDR_TRANSFERS = frozenset({"smpte2084", "arib-std-b67"})


@dataclass(frozen=True)
class StreamInfo:
    vcodec: Optional[str]
    acodec: Optional[str]
    codec_string: Optional[str]
    bit_depth: Optional[int]
    is_hdr: bool
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None


def video_family(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    raw = name.strip().lower().split(".")[0]
    if not raw or raw == "none":
        return None
    return _FAMILY.get(raw, raw)


def audio_family(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    raw = name.strip().lower().split(".")[0]
    if raw in {"mp4a", "aac"}:
        return "aac"
    return raw or None


def bit_depth_from_pix_fmt(pix_fmt: Optional[str]) -> Optional[int]:
    if not pix_fmt:
        return None
    fmt = pix_fmt.lower()
    if "12" in fmt:
        return 12
    if "10" in fmt:
        return 10
    return 8


def _parse_rate(value: Any) -> Optional[float]:
    raw = str(value or "")
    if "/" in raw:
        num, _, den = raw.partition("/")
        try:
            d = float(den)
            return float(num) / d if d else None
        except ValueError:
            return None
    try:
        return float(raw) if raw else None
    except ValueError:
        return None


def _int(value: Any) -> Optional[int]:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n


def _av1_level(width: int, height: int, fps: float) -> int:
    """Estimate AV1 seq_level_idx when ffprobe does not report one."""
    pixels = width * height
    if pixels <= 1280 * 720:
        return 5 if fps <= 30 else 8  # 3.1 / 4.0
    if pixels <= 1920 * 1080:
        return 8 if fps <= 30 else 9  # 4.0 / 4.1
    if pixels <= 4096 * 2176:
        return 12 if fps <= 30 else 13  # 5.0 / 5.1
    return 16  # 6.0


def _vp9_level(width: int, height: int, fps: float) -> int:
    pixels = width * height
    if pixels <= 1280 * 720:
        return 31
    if pixels <= 1920 * 1080:
        return 40 if fps <= 30 else 41
    if pixels <= 2560 * 1440:
        return 50
    if pixels <= 4096 * 2176:
        return 50 if fps <= 30 else 51
    return 61


_H264_PROFILES = {
    "baseline": 66,
    "constrained baseline": 66,
    "main": 77,
    "extended": 88,
    "high": 100,
    "high 10": 110,
    "high 4:2:2": 122,
    "high 4:4:4 predictive": 244,
}


def codec_string_for(stream: dict[str, Any]) -> Optional[str]:
    """Build an RFC 6381 ``codecs=`` value from an ffprobe video stream."""
    family = video_family(stream.get("codec_name"))
    profile = str(stream.get("profile") or "").strip().lower()
    level = _int(stream.get("level"))
    depth = bit_depth_from_pix_fmt(stream.get("pix_fmt")) or 8
    width = _int(stream.get("width")) or 1920
    height = _int(stream.get("height")) or 1080
    fps = _parse_rate(stream.get("avg_frame_rate")) or _parse_rate(stream.get("r_frame_rate")) or 30.0

    if family == "h264":
        pidc = _H264_PROFILES.get(profile, 100)
        constraint = 0x40 if profile == "constrained baseline" else 0
        lvl = level if level and level > 0 else 40
        return f"avc1.{pidc:02X}{constraint:02X}{lvl:02X}"
    if family == "hevc":
        main10 = "10" in profile or depth >= 10
        lvl = level if level and level > 0 else 120
        return f"hvc1.{'2.4' if main10 else '1.6'}.L{lvl}.B0"
    if family == "vp9":
        p = 2 if depth >= 10 else 0
        if "profile" in profile:
            p = _int(profile.replace("profile", "").strip()) or p
        lvl = level if level and level > 0 else _vp9_level(width, height, fps)
        return f"vp09.{p:02d}.{lvl:02d}.{depth:02d}"
    if family == "av1":
        p = {"main": 0, "high": 1, "professional": 2}.get(profile, 0)
        lvl = level if level is not None and 0 <= level <= 31 else _av1_level(width, height, fps)
        return f"av01.{p}.{lvl:02d}M.{depth:02d}"
    return None


def stream_info_from_ffprobe(data: dict[str, Any]) -> StreamInfo:
    video: Optional[dict[str, Any]] = None
    audio: Optional[dict[str, Any]] = None
    for stream in data.get("streams") or []:
        if not isinstance(stream, dict):
            continue
        kind = stream.get("codec_type")
        # Cover art is a 1-frame mjpeg/png "video" stream; skip it.
        disposition = stream.get("disposition") or {}
        if kind == "video" and video is None and not disposition.get("attached_pic"):
            video = stream
        elif kind == "audio" and audio is None:
            audio = stream
    if video is None:
        return StreamInfo(
            vcodec=None,
            acodec=audio_family(audio.get("codec_name")) if audio else None,
            codec_string=None,
            bit_depth=None,
            is_hdr=False,
        )
    transfer = str(video.get("color_transfer") or "").lower()
    return StreamInfo(
        vcodec=video_family(video.get("codec_name")),
        acodec=audio_family(audio.get("codec_name")) if audio else None,
        codec_string=codec_string_for(video),
        bit_depth=bit_depth_from_pix_fmt(video.get("pix_fmt")),
        is_hdr=transfer in _HDR_TRANSFERS,
        width=_int(video.get("width")),
        height=_int(video.get("height")),
        fps=_parse_rate(video.get("avg_frame_rate")),
    )


def probe_stream_info(path: Path) -> Optional[StreamInfo]:
    try:
        if not path.is_file() or path.stat().st_size <= 0:
            return None
    except OSError:
        return None
    try:
        result = subprocess.run(
            [
                ffprobe_bin(),
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,codec_name,profile,level,pix_fmt,color_transfer,"
                "width,height,avg_frame_rate,r_frame_rate:stream_disposition=attached_pic",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout or "{}")
    except (subprocess.SubprocessError, OSError, ValueError):
        return None
    return stream_info_from_ffprobe(data)


def apply_stream_info(video: Video, info: Optional[StreamInfo]) -> None:
    """Copy probe results onto the row (caller commits)."""
    video.media_probed_at = utcnow()
    if info is None:
        return
    video.vcodec = info.vcodec
    video.acodec = info.acodec
    video.codec_string = info.codec_string
    video.bit_depth = info.bit_depth
    video.is_hdr = info.is_hdr


def needs_compat(video: Video, cap: int = 1080) -> bool:
    """True when an 8-bit H.264 copy (short side ≤ ``cap``) would widen device support.

    Unknown codec (not yet probed) counts as eligible; audio-only never does.
    """
    if video.media_probed_at is not None and not video.vcodec:
        return False
    if video.vcodec is None:
        return True
    if video.vcodec != "h264":
        return True
    if (video.bit_depth or 8) > 8:
        return True
    short_side = min(video.width_px or 0, video.height_px or 0)
    return short_side > cap
