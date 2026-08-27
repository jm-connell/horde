"""Make downloaded files play on phones, not just desktop Chrome.

Desktop Chromium (including DevTools device mode) decodes AV1 and Opus-in-MP4.
Safari / iOS Chrome (WebKit) and many Android devices do not — they report the
file as incomplete or corrupt. Prefer H.264 + AAC at download time, then remux
with faststart (and transcode leftover incompatible streams when cheap).
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import activity, scanner
from .paths import to_rel_path

logger = logging.getLogger(__name__)

# Do not silently transcode 4K AV1/VP9 — that can run for hours on NAS CPUs.
MAX_HTML5_TRANSCODE_HEIGHT = 1080

_HTML5_VIDEO = frozenset({"h264", "avc", "avc1"})
_HTML5_AUDIO = frozenset({"aac", "mp4a", "mp3"})


@dataclass(frozen=True)
class MediaProbe:
    video_codec: Optional[str]
    audio_codec: Optional[str]
    width: Optional[int]
    height: Optional[int]
    format_name: str
    moov_front: Optional[bool]


@dataclass(frozen=True)
class CompatPlan:
    transcode_video: bool = False
    transcode_audio: bool = False
    remux_to_mp4: bool = False
    faststart: bool = False

    @property
    def needed(self) -> bool:
        return (
            self.transcode_video
            or self.transcode_audio
            or self.remux_to_mp4
            or self.faststart
        )


def codec_family(name: Optional[str]) -> str:
    if not name:
        return ""
    raw = name.strip().lower().replace(" ", "")
    if not raw or raw == "none":
        return ""
    return raw.split(".")[0]


def is_html5_video_codec(name: Optional[str]) -> bool:
    return codec_family(name) in _HTML5_VIDEO


def is_html5_audio_codec(name: Optional[str]) -> bool:
    return codec_family(name) in _HTML5_AUDIO


def is_mp4_container(format_name: str) -> bool:
    n = (format_name or "").lower()
    return any(token in n for token in ("mp4", "m4a", "mov", "3gp", "isom"))


def mp4_moov_before_mdat(path: Path) -> Optional[bool]:
    """True when the moov atom is before mdat (faststart). None if not MP4."""
    try:
        file_size = path.stat().st_size
        if file_size < 8:
            return None
        with path.open("rb") as f:
            pos = 0
            saw_ftyp = False
            while pos + 8 <= file_size:
                f.seek(pos)
                header = f.read(8)
                if len(header) < 8:
                    break
                size = int.from_bytes(header[:4], "big")
                tag = header[4:8]
                header_len = 8
                if size == 1:
                    ext = f.read(8)
                    if len(ext) < 8:
                        break
                    size = int.from_bytes(ext, "big")
                    header_len = 16
                elif size == 0:
                    size = file_size - pos
                if size < header_len:
                    break
                if tag == b"ftyp":
                    saw_ftyp = True
                elif tag == b"moov":
                    return True
                elif tag == b"mdat":
                    return False
                pos += size
            return True if saw_ftyp else None
    except OSError:
        return None


def html5_compat_plan(
    probe: MediaProbe,
    *,
    audio_only: bool = False,
    max_video_transcode_height: int = MAX_HTML5_TRANSCODE_HEIGHT,
) -> CompatPlan:
    """Decide how to rewrite a file so HTML5 players on phones can play it."""
    mp4 = is_mp4_container(probe.format_name)
    transcode_audio = bool(
        probe.audio_codec and not is_html5_audio_codec(probe.audio_codec)
    )
    transcode_video = False
    if (
        not audio_only
        and probe.video_codec
        and not is_html5_video_codec(probe.video_codec)
    ):
        height = probe.height or 0
        if height <= max_video_transcode_height:
            transcode_video = True
    remux_to_mp4 = not mp4
    faststart = False
    if mp4 and not audio_only:
        if probe.moov_front is False:
            faststart = True
    elif remux_to_mp4:
        faststart = True
    elif mp4 and transcode_audio:
        faststart = True
    return CompatPlan(
        transcode_video=transcode_video,
        transcode_audio=transcode_audio,
        remux_to_mp4=remux_to_mp4,
        faststart=faststart or transcode_video or remux_to_mp4,
    )


def probe_media(path: Path) -> Optional[MediaProbe]:
    if not path.exists() or path.stat().st_size <= 0:
        return None
    if not shutil.which("ffprobe"):
        return None
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,codec_name,width,height",
                "-show_entries",
                "format=format_name",
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
        data = json.loads(result.stdout)
    except (subprocess.SubprocessError, ValueError, OSError):
        return None
    video_codec = None
    audio_codec = None
    width = None
    height = None
    for stream in data.get("streams") or []:
        kind = stream.get("codec_type")
        codec = stream.get("codec_name")
        if kind == "video" and video_codec is None:
            video_codec = codec
            raw_w = stream.get("width")
            raw_h = stream.get("height")
            width = int(raw_w) if raw_w else None
            height = int(raw_h) if raw_h else None
        elif kind == "audio" and audio_codec is None:
            audio_codec = codec
    fmt = str((data.get("format") or {}).get("format_name") or "")
    moov_front = mp4_moov_before_mdat(path) if is_mp4_container(fmt) else None
    return MediaProbe(
        video_codec=video_codec,
        audio_codec=audio_codec,
        width=width,
        height=height,
        format_name=fmt,
        moov_front=moov_front,
    )


def _safe_rel(path: Path) -> Optional[str]:
    try:
        return to_rel_path(path)
    except ValueError:
        return None


def _replace(src: Path, dest: Path) -> None:
    src.replace(dest)


def ensure_html5_compatible(
    path: Path,
    *,
    audio_only: bool = False,
) -> Path:
    """Remux/transcode in place so phones can play the file. Returns the path."""
    probe = probe_media(path)
    if probe is None:
        return path
    plan = html5_compat_plan(probe, audio_only=audio_only)
    if not plan.needed:
        return path
    if not shutil.which("ffmpeg"):
        logger.warning("html5 remux skipped (no ffmpeg): %s", path.name)
        return path

    dest_path = path if path.suffix.lower() == ".mp4" else path.with_suffix(".mp4")
    tmp = dest_path.with_name(
        f"{dest_path.stem}.compat.{threading.get_ident()}.mp4"
    )
    tmp_rel = _safe_rel(tmp)
    dest_rel = _safe_rel(dest_path)
    if tmp_rel:
        scanner.mark_active(tmp_rel)
    if dest_rel and dest_path != path:
        scanner.mark_active(dest_rel)

    cmd = ["ffmpeg", "-y", "-i", str(path)]
    if audio_only or probe.video_codec is None:
        cmd += ["-vn"]
    elif plan.transcode_video:
        cmd += [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
        ]
    else:
        cmd += ["-c:v", "copy"]
    if probe.audio_codec is None:
        cmd += ["-an"]
    elif plan.transcode_audio:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
    else:
        cmd += ["-c:a", "copy"]
    cmd += ["-movflags", "+faststart", "-f", "mp4", str(tmp)]

    try:
        with activity.track(
            "compat",
            "Making file phone-compatible",
            reason="H.264 + AAC + faststart so phones can play the download",
            engine="ffmpeg",
            detail=path.name,
        ):
            subprocess.run(cmd, check=True, capture_output=True, timeout=4 * 3600)
            _replace(tmp, dest_path)
        if dest_path != path:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.warning("could not remove original after remux: %s", path)
        return dest_path
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("html5 remux failed for %s: %s", path.name, exc)
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        return path
    finally:
        if tmp_rel:
            scanner.unmark_active(tmp_rel)
        if dest_rel and dest_path != path:
            scanner.unmark_active(dest_rel)
        if tmp.exists():
            tmp.unlink(missing_ok=True)
