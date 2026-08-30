"""Make merged MP4s playable on iPhone Safari: AAC audio + faststart.

Video is always copied — never transcoded. The 1660 Super cannot decode AV1,
and we want AV1 archives. Safari on iPhone 15 Pro can decode AV1 in MP4 but
rejects Opus-in-MP4 and a moov atom after mdat.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import activity, scanner
from .paths import to_rel_path

logger = logging.getLogger(__name__)

_AAC_AUDIO = frozenset({"aac", "mp4a", "mp3"})


@dataclass(frozen=True)
class MediaProbe:
    video_codec: Optional[str]
    audio_codec: Optional[str]
    format_name: str
    moov_front: Optional[bool]


@dataclass(frozen=True)
class CompatPlan:
    transcode_audio: bool = False
    faststart: bool = False
    remux_to_mp4: bool = False

    @property
    def needed(self) -> bool:
        return self.transcode_audio or self.faststart or self.remux_to_mp4


def codec_family(name: Optional[str]) -> str:
    if not name:
        return ""
    raw = name.strip().lower().replace(" ", "")
    if not raw or raw == "none":
        return ""
    return raw.split(".")[0]


def is_aac_audio(name: Optional[str]) -> bool:
    return codec_family(name) in _AAC_AUDIO


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


def compat_plan(probe: MediaProbe) -> CompatPlan:
    transcode_audio = bool(probe.audio_codec) and not is_aac_audio(probe.audio_codec)
    remux_to_mp4 = not is_mp4_container(probe.format_name)
    if remux_to_mp4:
        return CompatPlan(
            transcode_audio=transcode_audio,
            faststart=True,
            remux_to_mp4=True,
        )
    faststart = probe.moov_front is not True
    if not transcode_audio and not faststart:
        return CompatPlan()
    return CompatPlan(transcode_audio=transcode_audio, faststart=True)


def ffmpeg_compat_cmd(
    src: Path,
    dest: Path,
    *,
    transcode_audio: bool,
    has_video: bool,
    has_audio: bool,
) -> list[str]:
    cmd = ["ffmpeg", "-y", "-i", str(src), "-map", "0"]
    if has_video:
        cmd.extend(["-c:v", "copy"])
    if has_audio:
        if transcode_audio:
            cmd.extend(["-c:a", "aac", "-b:a", "192k"])
        else:
            cmd.extend(["-c:a", "copy"])
    cmd.extend(["-movflags", "+faststart", str(dest)])
    return cmd


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
                "stream=codec_type,codec_name",
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
    except (subprocess.SubprocessError, ValueError, OSError, json.JSONDecodeError):
        return None
    video_codec: Optional[str] = None
    audio_codec: Optional[str] = None
    for stream in data.get("streams") or []:
        if not isinstance(stream, dict):
            continue
        kind = str(stream.get("codec_type") or "")
        name = stream.get("codec_name")
        codec = str(name) if name else None
        if kind == "video" and video_codec is None:
            video_codec = codec
        elif kind == "audio" and audio_codec is None:
            audio_codec = codec
    fmt = data.get("format") or {}
    format_name = str(fmt.get("format_name") or "")
    moov_front = mp4_moov_before_mdat(path) if is_mp4_container(format_name) else None
    return MediaProbe(
        video_codec=video_codec,
        audio_codec=audio_codec,
        format_name=format_name,
        moov_front=moov_front,
    )


def _replace_with_retries(src: Path, dest: Path, retries: int = 8) -> None:
    last_exc: Optional[OSError] = None
    for attempt in range(retries):
        try:
            src.replace(dest)
            return
        except PermissionError as exc:
            last_exc = exc
            time.sleep(0.2 * (attempt + 1))
        except OSError as exc:
            if getattr(exc, "winerror", None) not in (5, 32) and not isinstance(
                exc, PermissionError
            ):
                raise
            last_exc = exc
            time.sleep(0.2 * (attempt + 1))
    if last_exc is not None:
        raise last_exc


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _safe_rel(path: Path) -> Optional[str]:
    try:
        return to_rel_path(path)
    except ValueError:
        return None


def ensure_iphone_mp4(path: Path) -> Optional[str]:
    """Copy video, AAC audio if needed, faststart. None on success/noop."""
    if not path.exists():
        return None
    if not shutil.which("ffmpeg"):
        return "iPhone MP4 remux skipped: ffmpeg not found"
    probe = probe_media(path)
    if probe is None:
        logger.debug("mp4 compat: probe failed for %s", path.name)
        return None
    plan = compat_plan(probe)
    if not plan.needed:
        return None
    tmp = path.with_name(f"{path.stem}.compat.{threading.get_ident()}.mp4")
    tmp_rel = _safe_rel(tmp)
    if tmp_rel:
        scanner.mark_active(tmp_rel)
    cmd = ffmpeg_compat_cmd(
        path,
        tmp,
        transcode_audio=plan.transcode_audio,
        has_video=bool(probe.video_codec),
        has_audio=bool(probe.audio_codec),
    )
    try:
        with activity.track(
            "mp4_compat",
            "Preparing MP4 for phones",
            reason="AAC audio + faststart (video copied, no transcode)",
            engine="ffmpeg",
            detail=path.name,
        ):
            subprocess.run(cmd, check=True, capture_output=True, timeout=3600)
            _replace_with_retries(tmp, path)
        return None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("mp4 compat remux failed for %s: %s", path.name, exc)
        _safe_unlink(tmp)
        return "iPhone MP4 remux failed; file may not play on Safari"
    finally:
        if tmp_rel:
            scanner.unmark_active(tmp_rel)
        if tmp.exists():
            _safe_unlink(tmp)
