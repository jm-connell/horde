"""Probe ffmpeg encode capability in the Horde process (not Ollama VRAM)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .ffmpeg_bin import ffmpeg_bin

_CACHE_TTL_SEC = 60.0

_HEVC_HW = (
    "hevc_nvenc",
    "hevc_qsv",
    "hevc_vaapi",
    "hevc_amf",
    "hevc_videotoolbox",
)
_H264_HW = (
    "h264_nvenc",
    "h264_qsv",
    "h264_vaapi",
    "h264_amf",
    "h264_videotoolbox",
)
_HEVC_ALL = _HEVC_HW + ("libx265",)
_H264_ALL = _H264_HW + ("libx264",)

_KIND = {
    "hevc_nvenc": "nvenc",
    "h264_nvenc": "nvenc",
    "hevc_qsv": "qsv",
    "h264_qsv": "qsv",
    "hevc_vaapi": "vaapi",
    "h264_vaapi": "vaapi",
    "hevc_amf": "amf",
    "h264_amf": "amf",
    "hevc_videotoolbox": "videotoolbox",
    "h264_videotoolbox": "videotoolbox",
    "libx265": "software",
    "libx264": "software",
}

_lock = threading.Lock()
_cache: tuple[float, "EncodeCapabilities"] | None = None


@dataclass(frozen=True)
class EncoderChoice:
    name: str
    kind: str
    hw: bool


@dataclass(frozen=True)
class EncodeCapabilities:
    encoders: frozenset[str]
    hwaccels: frozenset[str]
    hw_h264: bool
    hw_hevc: bool
    ffmpeg_has_hw_encoder: bool
    gpu_name: Optional[str]
    gpu_vendor: Optional[str]
    encoder_h264: Optional[str]
    encoder_hevc: Optional[str]
    ffmpeg_bin: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "hw_h264": self.hw_h264,
            "hw_hevc": self.hw_hevc,
            "ffmpeg_has_hw_encoder": self.ffmpeg_has_hw_encoder,
            "gpu_name": self.gpu_name,
            "gpu_vendor": self.gpu_vendor,
            "encoder_h264": self.encoder_h264,
            "encoder_hevc": self.encoder_hevc,
            "ffmpeg_bin": self.ffmpeg_bin,
        }


def nvidia_device_present() -> bool:
    for path in ("/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-caps"):
        if Path(path).exists():
            return True
    return shutil.which("nvidia-smi") is not None


def dri_device_present() -> bool:
    dri = Path("/dev/dri")
    if not dri.is_dir():
        return False
    try:
        return any(True for _ in dri.iterdir())
    except OSError:
        return False


def encoder_usable(name: str, *, nvidia: bool, dri: bool) -> bool:
    """True when ffmpeg lists this encoder and the matching device is likely present."""
    kind = _KIND.get(name)
    if kind == "software":
        return True
    if kind == "nvenc":
        return nvidia
    if kind in {"qsv", "vaapi"}:
        return dri
    if kind == "amf":
        return dri or Path("/dev/kfd").exists()
    if kind == "videotoolbox":
        return sys.platform == "darwin"
    return False


def parse_ffmpeg_encoders(text: str) -> frozenset[str]:
    """Parse `ffmpeg -encoders` stdout for known H.264/HEVC encoder names."""
    found: set[str] = set()
    wanted = set(_HEVC_ALL + _H264_ALL)
    for raw in text.splitlines():
        for token in raw.split():
            if token in wanted:
                found.add(token)
    return frozenset(found)


def parse_ffmpeg_hwaccels(text: str) -> frozenset[str]:
    names = set()
    started = False
    for raw in text.splitlines():
        line = raw.strip().lower()
        if not started:
            if "hardware acceleration" in line or line == "hardware acceleration methods:":
                started = True
            continue
        if line:
            names.add(line)
    return frozenset(names)


def _run_ffmpeg(args: list[str], timeout: float = 8.0) -> str:
    bin_path = ffmpeg_bin()
    try:
        result = subprocess.run(
            [bin_path, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "AV_LOG_FORCE_NOCOLOR": "1"},
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    # ffmpeg prints -encoders / -hwaccels to stdout (sometimes stderr).
    return (result.stdout or "") + "\n" + (result.stderr or "")


def list_encoders() -> frozenset[str]:
    return parse_ffmpeg_encoders(_run_ffmpeg(["-hide_banner", "-encoders"]))


def list_hwaccels() -> frozenset[str]:
    return parse_ffmpeg_hwaccels(_run_ffmpeg(["-hide_banner", "-hwaccels"]))


def pick_encoder(
    target: str,
    encoders: frozenset[str],
    *,
    nvidia: Optional[bool] = None,
    dri: Optional[bool] = None,
) -> Optional[EncoderChoice]:
    """Pick best encoder for h264 or h265. NVENC → QSV → VAAPI/AMF → VideoToolbox → software."""
    want = "h265" if target in {"h265", "hevc"} else "h264"
    order = _HEVC_ALL if want == "h265" else _H264_ALL
    nvidia_ok = nvidia_device_present() if nvidia is None else nvidia
    dri_ok = dri_device_present() if dri is None else dri
    for name in order:
        if name not in encoders:
            continue
        if not encoder_usable(name, nvidia=nvidia_ok, dri=dri_ok):
            continue
        kind = _KIND.get(name, "software")
        return EncoderChoice(name=name, kind=kind, hw=kind != "software")
    return None


def _gpu_label() -> tuple[Optional[str], Optional[str]]:
    try:
        from .ai.workload import probe_local_gpu

        gpu = probe_local_gpu()
    except Exception:  # noqa: BLE001
        gpu = None
    if not isinstance(gpu, dict):
        return None, None
    name = gpu.get("name")
    vendor = gpu.get("vendor")
    return (
        str(name) if name else None,
        str(vendor) if vendor else None,
    )


def probe_encode_capabilities(*, force: bool = False) -> EncodeCapabilities:
    global _cache
    now = time.monotonic()
    with _lock:
        if not force and _cache is not None:
            ts, caps = _cache
            if now - ts < _CACHE_TTL_SEC:
                return caps

    encoders = list_encoders()
    hwaccels = list_hwaccels()
    nvidia = nvidia_device_present()
    dri = dri_device_present()
    h264 = pick_encoder("h264", encoders, nvidia=nvidia, dri=dri)
    hevc = pick_encoder("h265", encoders, nvidia=nvidia, dri=dri)
    hw_h264 = bool(h264 and h264.hw)
    hw_hevc = bool(hevc and hevc.hw)
    gpu_name, gpu_vendor = _gpu_label()
    caps = EncodeCapabilities(
        encoders=encoders,
        hwaccels=hwaccels,
        hw_h264=hw_h264,
        hw_hevc=hw_hevc,
        ffmpeg_has_hw_encoder=hw_h264 or hw_hevc,
        gpu_name=gpu_name,
        gpu_vendor=gpu_vendor,
        encoder_h264=h264.name if h264 else None,
        encoder_hevc=hevc.name if hevc else None,
        ffmpeg_bin=ffmpeg_bin(),
    )
    with _lock:
        _cache = (time.monotonic(), caps)
    return caps
