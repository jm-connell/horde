"""Permanent-file H.264/H.265 transcode after download (GPU when available)."""

from __future__ import annotations

import logging
import subprocess
import threading
from pathlib import Path
from typing import Optional

from . import activity, scanner
from .encode_probe import EncoderChoice, pick_encoder, probe_encode_capabilities
from .ffmpeg_bin import ffmpeg_bin
from .mp4_compat import codec_family, is_aac_audio, probe_media
from .paths import to_rel_path
from .ytdlp_formats import is_audio_preset, normalize_video_codec

logger = logging.getLogger(__name__)

_H264_FAM = frozenset({"h264", "avc", "avc1", "avc3"})
_HEVC_FAM = frozenset({"hevc", "h265", "hev1", "hvc1"})

_TRANSCODE_TIMEOUT_SEC = 8 * 3600


class TranscodeError(RuntimeError):
    """Video transcode failed; download should be marked postprocess."""

    def __init__(self, message: str):
        super().__init__(f"Postprocessing: {message}")


def is_h264_video(name: Optional[str]) -> bool:
    return codec_family(name) in _H264_FAM


def is_hevc_video(name: Optional[str]) -> bool:
    return codec_family(name) in _HEVC_FAM


def encode_target(
    job_codec: str,
    video_codec: Optional[str],
    height: Optional[int],
    *,
    preset: str = "",
) -> Optional[str]:
    """Return 'h264' or 'h265' when the file should be re-encoded, else None.

    H.265 at ≤1080p keeps native H.264 (already widely playable). 1080p AV1/VP9
    in that mode is encoded to H.264, not HEVC.
    """
    if preset and is_audio_preset(preset):
        return None
    codec = normalize_video_codec(job_codec)
    if codec == "av1":
        return None
    if codec == "h264":
        return None if is_h264_video(video_codec) else "h264"
    # h265
    if is_hevc_video(video_codec):
        return None
    if height is not None and height <= 1080:
        return None if is_h264_video(video_codec) else "h264"
    return "h265"


def ffmpeg_transcode_cmd(
    src: Path,
    dest: Path,
    encoder: EncoderChoice,
    *,
    has_audio: bool,
    transcode_audio: bool,
) -> list[str]:
    """Build an archive-quality ffmpeg command (not livestream CBR)."""
    cmd = [ffmpeg_bin(), "-y", "-i", str(src), "-map", "0:v:0"]
    name = encoder.name
    if name == "hevc_nvenc":
        cmd.extend(
            [
                "-c:v",
                "hevc_nvenc",
                "-preset",
                "p6",
                "-tune",
                "hq",
                "-rc",
                "vbr",
                "-cq",
                "19",
                "-b:v",
                "0",
                "-profile:v",
                "main",
                "-spatial-aq",
                "1",
                "-aq-strength",
                "8",
                "-rc-lookahead",
                "32",
            ]
        )
    elif name == "h264_nvenc":
        cmd.extend(
            [
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p6",
                "-tune",
                "hq",
                "-rc",
                "vbr",
                "-cq",
                "19",
                "-b:v",
                "0",
                "-profile:v",
                "high",
                "-spatial-aq",
                "1",
                "-rc-lookahead",
                "32",
            ]
        )
    elif name == "hevc_qsv":
        cmd.extend(["-c:v", "hevc_qsv", "-preset", "medium", "-global_quality", "22"])
    elif name == "h264_qsv":
        cmd.extend(["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "22"])
    elif name == "hevc_vaapi":
        cmd.extend(
            [
                "-vf",
                "format=nv12,hwupload",
                "-c:v",
                "hevc_vaapi",
                "-qp",
                "22",
            ]
        )
    elif name == "h264_vaapi":
        cmd.extend(
            [
                "-vf",
                "format=nv12,hwupload",
                "-c:v",
                "h264_vaapi",
                "-qp",
                "22",
            ]
        )
    elif name == "hevc_amf":
        cmd.extend(["-c:v", "hevc_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "20"])
    elif name == "h264_amf":
        cmd.extend(["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "20"])
    elif name == "hevc_videotoolbox":
        cmd.extend(["-c:v", "hevc_videotoolbox", "-q:v", "65"])
    elif name == "h264_videotoolbox":
        cmd.extend(["-c:v", "h264_videotoolbox", "-q:v", "65"])
    elif name == "libx265":
        cmd.extend(
            [
                "-c:v",
                "libx265",
                "-preset",
                "medium",
                "-crf",
                "22",
                "-x265-params",
                "log-level=error",
            ]
        )
    else:
        cmd.extend(["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-profile:v", "high"])

    cmd.extend(["-pix_fmt", "yuv420p"])
    if name.startswith("hevc_") or name == "libx265":
        cmd.extend(["-tag:v", "hvc1"])

    if has_audio:
        cmd.extend(["-map", "0:a:0"])
        if transcode_audio:
            cmd.extend(["-c:a", "aac", "-b:a", "192k", "-ac", "2"])
        else:
            cmd.extend(["-c:a", "copy"])
    else:
        cmd.append("-an")
    cmd.extend(["-movflags", "+faststart", "-f", "mp4", str(dest)])
    return cmd


def _safe_rel(path: Path) -> Optional[str]:
    try:
        return to_rel_path(path)
    except ValueError:
        return None


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def transcode_video(
    path: Path,
    target: str,
    *,
    encoder: Optional[EncoderChoice] = None,
) -> Path:
    """Re-encode ``path`` to H.264 or H.265 MP4. Raises TranscodeError on failure."""
    if not path.exists():
        raise TranscodeError("source file missing")
    caps = probe_encode_capabilities()
    choice = encoder or pick_encoder(
        target,
        caps.encoders,
    )
    if choice is None:
        label = "H.265" if target == "h265" else "H.264"
        raise TranscodeError(f"no {label} encoder available in ffmpeg")

    probe = probe_media(path)
    has_audio = bool(probe and probe.audio_codec)
    transcode_audio = bool(probe and probe.audio_codec and not is_aac_audio(probe.audio_codec))

    dest = path if path.suffix.lower() == ".mp4" else path.with_suffix(".mp4")
    tmp = dest.with_name(f"{dest.stem}.xcode.{threading.get_ident()}.mp4")
    tmp_rel = _safe_rel(tmp)
    if tmp_rel:
        scanner.mark_active(tmp_rel)

    cmd = ffmpeg_transcode_cmd(
        path,
        tmp,
        choice,
        has_audio=has_audio,
        transcode_audio=transcode_audio,
    )
    label = "H.265" if target == "h265" else "H.264"
    how = f"{choice.name} ({'GPU' if choice.hw else 'software'})"
    try:
        with activity.track(
            "transcode",
            f"Transcoding to {label}",
            reason=f"Compatibility archive via {how}",
            engine="ffmpeg",
            detail=path.name,
        ):
            result = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                timeout=_TRANSCODE_TIMEOUT_SEC,
            )
            if result.returncode != 0:
                err = (result.stderr or result.stdout or b"").decode("utf-8", "replace")
                logger.warning("transcode failed (%s): %s", choice.name, err[-800:])
                raise TranscodeError(f"ffmpeg {choice.name} failed")
            tmp.replace(dest)
        if dest != path:
            _safe_unlink(path)
        return dest
    except subprocess.TimeoutExpired as exc:
        _safe_unlink(tmp)
        raise TranscodeError("ffmpeg transcode timed out") from exc
    except OSError as exc:
        _safe_unlink(tmp)
        raise TranscodeError(f"ffmpeg transcode failed: {exc}") from exc
    finally:
        if tmp_rel:
            scanner.unmark_active(tmp_rel)
        if tmp.exists():
            _safe_unlink(tmp)
