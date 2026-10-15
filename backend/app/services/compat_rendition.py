"""H.264 compatibility renditions and in-place library conversion.

Two job kinds share one small worker pool:

* ``compat`` writes ``<stem>.horde-h264.mp4`` (≤1080p, 8-bit H.264, AAC,
  faststart) beside the untouched original. For YouTube sources it first tries
  YouTube's own avc1 stream (no encode, no quality loss); otherwise, or when
  that is unavailable, it encodes from the original with the best H.264
  encoder ffmpeg can use (NVENC → QSV → VAAPI → AMF → VideoToolbox → x264).
  NVIDIA cards without AV1 decode (Turing and older) decode AV1 on the CPU
  with dav1d and only encode on the GPU.
* ``convert`` re-encodes the original itself to H.264 at source resolution
  (the "H.264 only, convert" mode's bulk action). This replaces the file.

Progress is in memory (polled via the video row / compat endpoints); the
outcome is persisted on the ``videos`` row.
"""

from __future__ import annotations

import contextlib
import logging
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from sqlalchemy.orm.exc import StaleDataError
from sqlmodel import Session, select

from .. import config
from ..config import DOWNLOADS_DIR
from ..database import engine
from ..models import Video, VideoStatus
from . import activity
from .encode_probe import (
    EncoderChoice,
    list_filters,
    pick_encoder,
    probe_encode_capabilities,
)
from .ffmpeg_bin import ffmpeg_available, ffmpeg_bin
from .ffmpeg_progress import FfmpegCancelled, run_ffmpeg
from .fsutil import safe_unlink
from .media_info import apply_stream_info, needs_compat, probe_stream_info
from .mp4_compat import ensure_safari_mp4
from .paths import (
    COMPAT_SIDECAR_TOKEN,
    compat_sidecar_path,
    resolve_compat_path,
    to_rel_path,
)
from .ytdlp_formats import (
    COMPAT_MAX_HEIGHT,
    FORMAT_SORT_H264,
    apply_audio_format_id,
    compat_copy_cap,
    compat_format_spec,
    pick_original_audio_format,
)

logger = logging.getLogger(__name__)

JobKind = Literal["compat", "convert"]

_ENCODE_TIMEOUT_SEC = 8 * 3600
# Rough 1080p/720p/480p H.264 bitrates at our quality settings (for estimates).
_EST_BPS = (
    (2160, 18_000_000),
    (1440, 9_000_000),
    (1080, 5_000_000),
    (720, 2_500_000),
    (480, 1_200_000),
    (0, 700_000),
)


class CompatError(RuntimeError):
    pass


@dataclass
class _Job:
    video_id: int
    kind: JobKind
    prefer_download: bool
    reason: str
    status: str = "queued"  # queued | running
    stage: str = "queued"  # queued | downloading | encoding | finishing
    progress: float = 0.0
    cancel: threading.Event = field(default_factory=threading.Event)


_lock = threading.Lock()
_jobs: dict[int, _Job] = {}
_pending: deque[int] = deque()
_running: set[int] = set()
_errors: dict[int, str] = {}


# ---------------------------------------------------------------------------
# ffmpeg command
# ---------------------------------------------------------------------------


def compat_dimensions(
    width: int | None,
    height: int | None,
    cap: int = COMPAT_MAX_HEIGHT,
) -> tuple[int, int] | None:
    """Scale so the short side is ≤``cap`` (keeps vertical video sharp). None = keep size."""
    if not width or not height:
        return None
    short = min(width, height)
    if short <= cap:
        if width % 2 == 0 and height % 2 == 0:
            return None
        return (width - width % 2, height - height % 2)
    factor = cap / short
    w = int(round(width * factor / 2)) * 2
    h = int(round(height * factor / 2)) * 2
    return (w, h)


def _rate_limits(short_side: int) -> tuple[str, str]:
    """VBV ceiling for the copy: keeps 4K copies sane without starving them."""
    if short_side > 1440:
        return ("40M", "80M")
    if short_side > 1080:
        return ("20M", "40M")
    return ("12M", "24M")


_TONEMAP = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
    "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv"
)

_HW_DECODE_FAMILIES = frozenset({"h264", "hevc", "vp9"})


def compat_ffmpeg_cmd(
    src: Path,
    dest: Path,
    encoder: EncoderChoice,
    *,
    src_vcodec: str | None,
    bit_depth: int | None,
    width: int | None,
    height: int | None,
    fps: float | None,
    is_hdr: bool,
    copy_audio: bool,
    filters: frozenset[str] = frozenset(),
    hw_decode: bool = True,
    tonemap: bool = True,
    cap: int = COMPAT_MAX_HEIGHT,
) -> list[str]:
    """ffmpeg args for a ≤1080p 8-bit H.264 High + AAC faststart MP4."""
    cmd = [ffmpeg_bin(), "-y"]
    name = encoder.name
    # NVDEC on GTX 16xx/RTX 20xx handles H.264/HEVC/VP9 but not AV1; dav1d
    # (CPU) is fast enough and ffmpeg picks it automatically.
    if (
        hw_decode
        and encoder.kind == "nvenc"
        and src_vcodec in _HW_DECODE_FAMILIES
        and not (src_vcodec == "h264" and (bit_depth or 8) > 8)
    ):
        cmd.extend(["-hwaccel", "cuda"])
    if encoder.kind == "vaapi":
        cmd.extend(
            [
                "-init_hw_device",
                "vaapi=va:/dev/dri/renderD128",
                "-filter_hw_device",
                "va",
            ]
        )
    cmd.extend(["-i", str(src), "-map", "0:v:0"])

    vf: list[str] = []
    dims = compat_dimensions(width, height, cap)
    out_short = min(dims) if dims else min(width or cap, height or cap, cap)
    maxrate, bufsize = _rate_limits(out_short)
    if dims:
        vf.append(f"scale={dims[0]}:{dims[1]}:flags=bicubic")
    if tonemap and is_hdr and {"zscale", "tonemap"} <= filters:
        vf.append(_TONEMAP)
    if encoder.kind == "vaapi":
        vf.extend(["format=nv12", "hwupload"])
    elif encoder.kind == "qsv":
        vf.append("format=nv12")
    else:
        vf.append("format=yuv420p")
    cmd.extend(["-vf", ",".join(vf)])

    gop = str(max(24, int(round((fps or 30.0) * 2))))
    if name == "h264_nvenc":
        cmd.extend(
            [
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p5",
                "-tune",
                "hq",
                "-rc",
                "vbr",
                "-cq",
                "23",
                "-b:v",
                "0",
                "-maxrate",
                maxrate,
                "-bufsize",
                bufsize,
                "-profile:v",
                "high",
                "-spatial-aq",
                "1",
                "-rc-lookahead",
                "20",
            ]
        )
    elif name == "h264_qsv":
        cmd.extend(
            [
                "-c:v",
                "h264_qsv",
                "-preset",
                "medium",
                "-global_quality",
                "25",
                "-profile:v",
                "high",
            ]
        )
    elif name == "h264_vaapi":
        cmd.extend(["-c:v", "h264_vaapi", "-qp", "24", "-profile:v", "high"])
    elif name == "h264_amf":
        cmd.extend(
            [
                "-c:v",
                "h264_amf",
                "-quality",
                "balanced",
                "-rc",
                "cqp",
                "-qp_i",
                "23",
                "-qp_p",
                "25",
            ]
        )
    elif name == "h264_videotoolbox":
        cmd.extend(["-c:v", "h264_videotoolbox", "-q:v", "55", "-profile:v", "high"])
    else:
        cmd.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-maxrate",
                maxrate,
                "-bufsize",
                bufsize,
                "-profile:v",
                "high",
            ]
        )
    cmd.extend(["-g", gop])
    cmd.extend(["-map", "0:a:0?"])
    if copy_audio:
        cmd.extend(["-c:a", "copy"])
    else:
        cmd.extend(["-c:a", "aac", "-b:a", "160k", "-ac", "2"])
    cmd.extend(["-movflags", "+faststart", "-f", "mp4", str(dest)])
    return cmd


# ---------------------------------------------------------------------------
# Status / estimates
# ---------------------------------------------------------------------------


def estimate_compat_bytes(video: Video, cap: int = COMPAT_MAX_HEIGHT) -> int:
    short = min(video.width_px or 1080, video.height_px or 1080)
    short = min(short, cap)
    bps = next(rate for floor, rate in _EST_BPS if short >= floor)
    duration = video.duration_sec or 0.0
    return int(duration * (bps + 160_000) / 8)


def job_state(video_id: int) -> dict[str, Any] | None:
    with _lock:
        job = _jobs.get(video_id)
        if job is None:
            return None
        return {
            "kind": job.kind,
            "status": job.status,
            "stage": job.stage,
            "progress": round(job.progress, 1),
        }


def compat_status(video: Video) -> dict[str, Any]:
    """Compact status for VideoRead / the compat endpoint."""
    state = job_state(video.id) if video.id is not None else None
    if state is not None:
        return {**state, "error": None}
    path = resolve_compat_path(video)
    if path is not None and path.is_file():
        return {
            "kind": "compat",
            "status": "ready",
            "stage": None,
            "progress": 100.0,
            "error": None,
        }
    err = video.compat_error or (
        _errors.get(video.id) if video.id is not None else None
    )
    if err:
        return {
            "kind": "compat",
            "status": "error",
            "stage": None,
            "progress": 0.0,
            "error": err,
        }
    return {
        "kind": "compat",
        "status": "none",
        "stage": None,
        "progress": 0.0,
        "error": None,
    }


def queue_counts() -> dict[str, int]:
    with _lock:
        counts = {"queued": 0, "running": 0, "convert_queued": 0, "convert_running": 0}
        for job in _jobs.values():
            prefix = "convert_" if job.kind == "convert" else ""
            counts[f"{prefix}{job.status}"] += 1
        return counts


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------


def _slot_limit() -> int:
    if config.MAX_FFMPEG_CONCURRENCY:
        return config.MAX_FFMPEG_CONCURRENCY
    try:
        return 2 if probe_encode_capabilities().hw_h264 else 1
    except Exception:  # noqa: BLE001
        return 1


def enqueue(
    video_id: int,
    *,
    kind: JobKind = "compat",
    prefer_download: bool = True,
    reason: str = "Device cannot decode the original",
    front: bool = False,
) -> str:
    """Queue a job. Idempotent per video.

    Returns 'queued' for a new job, else 'already_queued' / 'already_running'.
    """
    with _lock:
        existing = _jobs.get(video_id)
        if existing is not None:
            if front and existing.status == "queued":
                # A viewer is waiting on this one — jump the bulk backfill.
                with contextlib.suppress(ValueError):
                    _pending.remove(video_id)
                _pending.appendleft(video_id)
            return f"already_{existing.status}"
        _errors.pop(video_id, None)
        _jobs[video_id] = _Job(
            video_id=video_id,
            kind=kind,
            prefer_download=prefer_download,
            reason=reason,
        )
        if front:
            _pending.appendleft(video_id)
        else:
            _pending.append(video_id)
    activity.note_queued("compat" if kind == "compat" else "transcode", 1)
    _dispatch()
    return "queued"


def cancel(video_id: int) -> bool:
    with _lock:
        job = _jobs.get(video_id)
        if job is None:
            return False
        job.cancel.set()
        if job.status == "queued":
            with contextlib.suppress(ValueError):
                _pending.remove(video_id)
            _jobs.pop(video_id, None)
            queued_kind = job.kind
        else:
            return True
    activity.note_queued("compat" if queued_kind == "compat" else "transcode", -1)
    return True


def cancel_all(kind: JobKind | None = None) -> int:
    """Drop queued jobs (and signal running ones) of ``kind`` (or all)."""
    with _lock:
        ids = [vid for vid, job in _jobs.items() if kind is None or job.kind == kind]
    for vid in ids:
        cancel(vid)
    return len(ids)


def _dispatch() -> None:
    while True:
        with _lock:
            if len(_running) >= _slot_limit() or not _pending:
                return
            video_id = _pending.popleft()
            job = _jobs.get(video_id)
            if job is None:
                continue
            job.status = "running"
            _running.add(video_id)
        activity.note_queued("compat" if job.kind == "compat" else "transcode", -1)
        threading.Thread(
            target=_worker, args=(job,), daemon=True, name=f"compat-{video_id}"
        ).start()


def _worker(job: _Job) -> None:
    try:
        if job.kind == "convert":
            _run_convert(job)
        else:
            _run_compat(job)
    except (FfmpegCancelled, _Cancelled):
        logger.info("compat job %s cancelled", job.video_id)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc) or exc.__class__.__name__
        logger.warning("compat job %s (%s) failed: %s", job.video_id, job.kind, msg)
        with _lock:
            _errors[job.video_id] = msg[:300]
        _save(job.video_id, compat_error=msg[:300])
    finally:
        with _lock:
            _running.discard(job.video_id)
            _jobs.pop(job.video_id, None)
        _dispatch()


class _Cancelled(Exception):
    pass


def _save(video_id: int, **fields: Any) -> None:
    with Session(engine) as session:
        video = session.get(Video, video_id)
        if video is None:
            return
        for key, value in fields.items():
            setattr(video, key, value)
        session.add(video)
        try:
            session.commit()
        except StaleDataError:
            session.rollback()


def _set(job: _Job, *, stage: str | None = None, progress: float | None = None) -> None:
    with _lock:
        if stage is not None:
            job.stage = stage
        if progress is not None:
            job.progress = max(0.0, min(100.0, progress))


@dataclass(frozen=True)
class _Source:
    path: Path
    title: str
    source_url: str | None
    platform: str | None
    duration: float | None
    width: int | None
    height: int | None
    fps: float | None


def _load_source(video_id: int) -> _Source | None:
    with Session(engine) as session:
        video = session.get(Video, video_id)
        if video is None or video.status != VideoStatus.ready:
            return None
        root = DOWNLOADS_DIR.resolve()
        path = (root / video.file_path).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            return None
        if not path.is_file():
            return None
        return _Source(
            path=path,
            title=video.title,
            source_url=video.source_url,
            platform=video.platform,
            duration=video.duration_sec,
            width=video.width_px,
            height=video.height_px,
            fps=video.frame_rate,
        )


# ---------------------------------------------------------------------------
# compat (sidecar) job
# ---------------------------------------------------------------------------


def _is_youtube(src: _Source) -> bool:
    url = (src.source_url or "").lower()
    return (
        "youtube" in (src.platform or "").lower()
        or "youtube.com" in url
        or "youtu.be" in url
    )


def _run_compat(job: _Job) -> None:
    src = _load_source(job.video_id)
    if src is None:
        return
    dest = compat_sidecar_path(src.path)
    with Session(engine) as session:
        video = session.get(Video, job.video_id)
        if video is None:
            return
        existing = resolve_compat_path(video)
        if existing is not None and existing.is_file():
            return
        if video.media_probed_at is None:
            apply_stream_info(video, probe_stream_info(src.path))
            session.add(video)
            session.commit()
        cap = compat_copy_cap()
        if not needs_compat(video, cap):
            return
        src_vcodec = video.vcodec
        bit_depth = video.bit_depth
        is_hdr = bool(video.is_hdr)
        copy_audio = video.acodec == "aac"

    with activity.track(
        "compat",
        "Creating H.264 compatibility copy",
        reason=job.reason,
        engine="yt-dlp/ffmpeg",
        detail=src.title,
        video_id=job.video_id,
        total=100,
        done=0,
    ) as handle:

        def progress(pct: float) -> None:
            _set(job, progress=pct)
            handle.update(done=int(pct))

        produced: Path | None = None
        source_kind = "youtube"
        download_note: str | None = None
        # YouTube only serves H.264 up to 1080p; a full-res copy of a 1440p/4K
        # source has to be encoded here.
        src_short = min(src.width or 0, src.height or 0)
        native_ok = src_short <= COMPAT_MAX_HEIGHT or cap <= COMPAT_MAX_HEIGHT
        if job.prefer_download and native_ok and src.source_url and _is_youtube(src):
            _set(job, stage="downloading", progress=0.0)
            handle.update(label="Downloading YouTube's H.264 copy")
            try:
                produced = _download_native_h264(src, dest, job.cancel, progress)
            except _Cancelled:
                raise
            except Exception as exc:  # noqa: BLE001
                download_note = str(exc)
                logger.info(
                    "native H.264 download failed for %s: %s", job.video_id, exc
                )
                produced = None
        if job.cancel.is_set():
            raise _Cancelled()

        if produced is None:
            source_kind = "transcode"
            _set(job, stage="encoding", progress=0.0)
            produced = _encode_compat(
                src,
                dest,
                job,
                progress,
                handle,
                src_vcodec=src_vcodec,
                bit_depth=bit_depth,
                is_hdr=is_hdr,
                copy_audio=copy_audio,
                cap=cap,
            )
            if download_note:
                logger.debug(
                    "compat %s fell back to encode: %s", job.video_id, download_note
                )

        _set(job, stage="finishing", progress=100.0)
        final = ensure_safari_mp4(produced, cancel_event=job.cancel)
        if final != dest:
            final.replace(dest)
        size = dest.stat().st_size
        _save(
            job.video_id,
            compat_path=to_rel_path(dest),
            compat_size=size,
            compat_source=source_kind,
            compat_error=None,
        )


def _download_native_h264(
    src: _Source,
    dest: Path,
    cancel_event: threading.Event,
    on_progress: Callable[[float], None],
) -> Path | None:
    """Fetch YouTube's avc1 stream (≤1080p) to ``dest``. None when not offered."""
    import yt_dlp

    from .ytdlp_common import (
        apply_cookie_opts,
        url_cookie_required,
        youtube_extractor_args,
    )

    url = src.source_url or ""
    vertical = bool(src.width and src.height and src.height > src.width)
    short = min(src.width or COMPAT_MAX_HEIGHT, src.height or COMPAT_MAX_HEIGHT)
    cap = min(short, COMPAT_MAX_HEIGHT)
    spec = compat_format_spec(cap, vertical=vertical)

    def hook(d: dict[str, Any]) -> None:
        if cancel_event.is_set():
            raise _Cancelled()
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            if total:
                on_progress(min(99.0, done * 100.0 / total))

    tmp_base = dest.with_name(f"{src.path.stem}{COMPAT_SIDECAR_TOKEN}dl")
    opts: dict[str, Any] = {
        "outtmpl": f"{tmp_base}.%(ext)s",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "merge_output_format": "mp4",
        "overwrites": True,
        "format_sort": list(FORMAT_SORT_H264),
        "extractor_args": youtube_extractor_args(),
        "progress_hooks": [hook],
    }
    if url_cookie_required(url):
        opts = apply_cookie_opts(opts)

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if not isinstance(info, dict):
            return None
        formats = info.get("formats") or []
        if not any(str(f.get("vcodec") or "").startswith("avc") for f in formats):
            return None
        audio = pick_original_audio_format(info)
        if audio and audio.get("format_id"):
            spec = apply_audio_format_id([spec], str(audio["format_id"]))[0]
        ydl.params["format"] = spec
        ydl.process_ie_result(info, download=True)
    if cancel_event.is_set():
        raise _Cancelled()
    out = Path(f"{tmp_base}.mp4")
    if not out.is_file():
        # Merge may have kept another container (rare); take whatever landed.
        # (No glob: titles contain "[id]", which glob treats as a pattern.)
        prefix = f"{tmp_base.name}."
        candidates = sorted(
            c
            for c in tmp_base.parent.iterdir()
            if c.name.startswith(prefix) and c.suffix in {".mp4", ".mkv", ".webm"}
        )
        out = candidates[0] if candidates else out
    if not out.is_file() or out.stat().st_size <= 0:
        return None
    return out


def _encode_compat(
    src: _Source,
    dest: Path,
    job: _Job,
    on_progress: Callable[[float], None],
    handle: activity.ActivityHandle,
    *,
    src_vcodec: str | None,
    bit_depth: int | None,
    is_hdr: bool,
    copy_audio: bool,
    cap: int = COMPAT_MAX_HEIGHT,
) -> Path:
    if not ffmpeg_available():
        raise CompatError("ffmpeg is not available")
    caps = probe_encode_capabilities()
    choice = pick_encoder("h264", caps.encoders)
    if choice is None:
        raise CompatError("No H.264 encoder available in ffmpeg")
    handle.update(
        label="Encoding H.264 compatibility copy",
        engine=f"ffmpeg {choice.name} ({'GPU' if choice.hw else 'CPU'})",
    )
    tmp = dest.with_name(f"{src.path.stem}{COMPAT_SIDECAR_TOKEN}enc.mp4")
    filters = list_filters()

    def build(hw_decode: bool, tonemap: bool = True) -> list[str]:
        return compat_ffmpeg_cmd(
            src.path,
            tmp,
            choice,
            src_vcodec=src_vcodec,
            bit_depth=bit_depth,
            width=src.width,
            height=src.height,
            fps=src.fps,
            is_hdr=is_hdr,
            copy_audio=copy_audio,
            filters=filters,
            hw_decode=hw_decode,
            tonemap=tonemap,
            cap=cap,
        )

    # Retry ladder: drop NVDEC first, then HDR tonemapping (zscale rejects
    # files with incomplete colour tags) — washed-out beats unplayable.
    attempts: list[tuple[bool, bool]] = []
    for combo in ((True, True), (False, True), (False, False)):
        cmd = build(*combo)
        if combo != (True, True) and any(cmd == build(*a) for a in attempts):
            continue
        attempts.append(combo)
    last_err = ""
    for hw_decode, tonemap in attempts:
        try:
            run_ffmpeg(
                build(hw_decode, tonemap),
                duration=src.duration,
                on_progress=on_progress,
                cancel_event=job.cancel,
                timeout=_ENCODE_TIMEOUT_SEC,
            )
            return tmp
        except FfmpegCancelled:
            safe_unlink(tmp)
            raise
        except subprocess.CalledProcessError as exc:
            raw = exc.stderr or exc.stdout or b""
            last_err = (
                raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
            )
            logger.warning(
                "compat encode failed (%s, hw_decode=%s, tonemap=%s): %s",
                choice.name,
                hw_decode,
                tonemap,
                last_err[-600:],
            )
            safe_unlink(tmp)
        except subprocess.TimeoutExpired as exc:
            safe_unlink(tmp)
            raise CompatError("H.264 encode timed out") from exc
    raise CompatError(f"ffmpeg {choice.name} failed")


# ---------------------------------------------------------------------------
# convert (in place) job
# ---------------------------------------------------------------------------


def _run_convert(job: _Job) -> None:
    from .video_transcode import transcode_video

    src = _load_source(job.video_id)
    if src is None:
        return
    info = probe_stream_info(src.path)
    if info is not None and info.vcodec == "h264" and (info.bit_depth or 8) <= 8:
        return
    if info is not None and info.vcodec is None:
        return  # audio-only
    _set(job, stage="encoding", progress=0.0)
    with activity.track(
        "transcode",
        "Converting to H.264",
        reason=job.reason,
        engine="ffmpeg",
        detail=src.title,
        video_id=job.video_id,
        total=100,
        done=0,
    ) as handle:

        def progress(pct: float) -> None:
            _set(job, progress=pct)
            handle.update(done=int(pct))

        new_path = transcode_video(
            src.path,
            "h264",
            cancel_event=job.cancel,
            on_progress=progress,
            duration=src.duration,
        )
    _set(job, stage="finishing", progress=100.0)
    with Session(engine) as session:
        video = session.get(Video, job.video_id)
        if video is None:
            return
        video.file_path = to_rel_path(new_path)
        video.file_size = new_path.stat().st_size
        apply_stream_info(video, probe_stream_info(new_path))
        # A ≤1080p H.264 original makes the sidecar redundant.
        old_compat = resolve_compat_path(video)
        if old_compat is not None and not needs_compat(video, compat_copy_cap()):
            safe_unlink(old_compat)
            video.compat_path = None
            video.compat_size = None
            video.compat_source = None
        video.compat_error = None
        session.add(video)
        session.commit()


# ---------------------------------------------------------------------------
# Library-wide helpers
# ---------------------------------------------------------------------------


def eligible_video_ids(session: Session, *, kind: JobKind) -> list[int]:
    rows = session.exec(
        select(Video).where(
            Video.status == VideoStatus.ready,
            Video.needs_review == False,  # noqa: E712 - SQL column expression
        )
    ).all()
    cap = compat_copy_cap()
    out: list[int] = []
    for video in rows:
        if video.id is None:
            continue
        if kind == "compat":
            path = resolve_compat_path(video)
            if path is not None and path.is_file():
                continue
            if needs_compat(video, cap):
                out.append(video.id)
        else:
            if video.media_probed_at is not None and not video.vcodec:
                continue
            if video.vcodec == "h264" and (video.bit_depth or 8) <= 8:
                continue
            out.append(video.id)
    return out


def library_summary(session: Session) -> dict[str, Any]:
    rows = session.exec(
        select(Video).where(
            Video.status == VideoStatus.ready,
            Video.needs_review == False,  # noqa: E712 - SQL column expression
        )
    ).all()
    total_bytes = 0
    compat_ready = 0
    compat_bytes = 0
    missing = 0
    missing_est = 0
    convertible = 0
    convertible_bytes = 0
    unprobed = 0
    by_codec: dict[str, int] = {}
    cap = compat_copy_cap()
    for video in rows:
        total_bytes += video.file_size or 0
        if video.media_probed_at is None:
            unprobed += 1
        codec = video.vcodec or ("audio" if video.media_probed_at else "unknown")
        by_codec[codec] = by_codec.get(codec, 0) + 1
        path = resolve_compat_path(video)
        if path is not None and path.is_file():
            compat_ready += 1
            compat_bytes += video.compat_size or 0
        elif needs_compat(video, cap):
            missing += 1
            missing_est += estimate_compat_bytes(video, cap)
        if video.vcodec and (video.vcodec != "h264" or (video.bit_depth or 8) > 8):
            convertible += 1
            convertible_bytes += video.file_size or 0
    return {
        "copy_cap": cap,
        "videos": len(rows),
        "library_bytes": total_bytes,
        "by_codec": by_codec,
        "unprobed": unprobed,
        "compat_ready": compat_ready,
        "compat_bytes": compat_bytes,
        "compat_missing": missing,
        "compat_missing_est_bytes": missing_est,
        "convertible": convertible,
        "convertible_bytes": convertible_bytes,
        **queue_counts(),
    }


def delete_compat_files(video: Video) -> None:
    path = resolve_compat_path(video)
    if path is not None:
        safe_unlink(path)


# ---------------------------------------------------------------------------
# Startup: probe codecs for rows that predate the columns
# ---------------------------------------------------------------------------

_backfill_stop = threading.Event()
_backfill_thread: threading.Thread | None = None


def _probe_backfill_loop() -> None:
    # Let startup settle first; ffprobe is cheap but the library may be large.
    if _backfill_stop.wait(10.0):
        return
    # Unreadable files (NAS offline, mid-move) stay unprobed for a later boot.
    skipped: set[int] = set()
    while not _backfill_stop.is_set():
        with Session(engine) as session:
            query = select(Video).where(
                Video.media_probed_at == None,  # noqa: E711
                Video.status == VideoStatus.ready,
            )
            if skipped:
                query = query.where(Video.id.notin_(skipped))  # type: ignore[union-attr]
            batch = session.exec(query.limit(25)).all()
            if not batch:
                return
            for video in batch:
                if _backfill_stop.is_set():
                    return
                path = (DOWNLOADS_DIR / video.file_path).resolve()
                info = probe_stream_info(path)
                if info is None:
                    skipped.add(video.id)
                    continue
                apply_stream_info(video, info)
                session.add(video)
            try:
                session.commit()
            except StaleDataError:
                session.rollback()
        time.sleep(0.5)


def start_probe_backfill() -> None:
    global _backfill_thread
    if _backfill_thread is not None and _backfill_thread.is_alive():
        return
    _backfill_stop.clear()
    _backfill_thread = threading.Thread(
        target=_probe_backfill_loop, daemon=True, name="codec-probe-backfill"
    )
    _backfill_thread.start()


def stop_probe_backfill() -> None:
    _backfill_stop.set()
