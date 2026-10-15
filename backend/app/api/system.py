"""Best-effort host resource stats (CPU/RAM/GPU). Keep health ready-check cheap."""

from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
from typing import Any

from fastapi import APIRouter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/system", tags=["system"])


def _looks_like_arch_string(name: str) -> bool:
    import re

    return bool(re.search(r"Family\s+\d+\s+Model", name, re.I))


def _cpu_model() -> str | None:
    # Windows: marketing name from registry (not platform.processor arch string).
    try:
        import sys

        if sys.platform == "win32":
            import winreg  # type: ignore

            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            )
            try:
                value, _ = winreg.QueryValueEx(key, "ProcessorNameString")
                name = str(value).strip()
                if name and not _looks_like_arch_string(name):
                    return name
            finally:
                winreg.CloseKey(key)
    except Exception:
        logger.debug(
            "could not read the CPU model from the Windows registry",
            exc_info=True,
        )

    # Linux
    try:
        with open("/proc/cpuinfo", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                if line.lower().startswith("model name"):
                    name = line.split(":", 1)[1].strip()
                    if name:
                        return name
    except Exception:
        logger.debug(
            "could not read the CPU model from /proc/cpuinfo",
            exc_info=True,
        )

    # macOS
    try:
        result = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        name = (result.stdout or "").strip()
        if name:
            return name
    except Exception:
        logger.debug(
            "could not read the CPU model via sysctl",
            exc_info=True,
        )

    try:
        name = platform.processor().strip()
        if name and not _looks_like_arch_string(name):
            return name
    except Exception:
        logger.debug(
            "could not read the CPU model from platform",
            exc_info=True,
        )
    return None


def _cpu_temp() -> float | None:
    try:
        import psutil  # type: ignore

        temps = psutil.sensors_temperatures(fahrenheit=False)
        if not temps:
            return None
        # Prefer package / Tctl / CPU-ish labels
        preferred = ("coretemp", "k10temp", "cpu_thermal", "acpitz", "pch")
        for key in preferred:
            entries = temps.get(key)
            if entries:
                for e in entries:
                    if e.current is not None:
                        return float(e.current)
        for entries in temps.values():
            for e in entries:
                if e.current is not None:
                    return float(e.current)
    except Exception:
        logger.debug(
            "could not read CPU temperature sensors",
            exc_info=True,
        )
    return None


def _cpu_ram() -> dict[str, Any]:
    out: dict[str, Any] = {
        "cpu_percent": None,
        "cpu_model": _cpu_model(),
        "cpu_temp_c": _cpu_temp(),
        "ram_used_bytes": None,
        "ram_total_bytes": None,
        "ram_percent": None,
    }
    try:
        import psutil  # type: ignore

        out["cpu_percent"] = float(psutil.cpu_percent(interval=None))
        mem = psutil.virtual_memory()
        out["ram_used_bytes"] = int(mem.used)
        out["ram_total_bytes"] = int(mem.total)
        out["ram_percent"] = float(mem.percent)
    except Exception:
        logger.debug(
            "could not read CPU and memory usage",
            exc_info=True,
        )
    return out


def host_gpu() -> dict[str, Any] | None:
    """Return local GPU stats (NVIDIA / AMD / Intel), or None if unavailable."""
    from ..services.ai.workload import probe_local_gpu

    return probe_local_gpu()


# Back-compat aliases
nvidia_gpu = host_gpu
_nvidia_gpu = host_gpu


@router.get("/stats")
def system_stats():
    cpu_ram = _cpu_ram()
    gpu = host_gpu()
    encode = None
    try:
        from ..services.encode_probe import probe_encode_capabilities

        encode = probe_encode_capabilities().to_dict()
    except Exception:
        logger.debug("encode capabilities unavailable", exc_info=True)
        encode = None
    disk = None
    try:
        from ..config import DOWNLOADS_DIR

        usage = shutil.disk_usage(DOWNLOADS_DIR)
        disk = {
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
        }
    except Exception:
        # The Settings page polls this endpoint.
        logger.debug("could not read disk usage of %s", DOWNLOADS_DIR, exc_info=True)
    return {
        "cpu_percent": cpu_ram["cpu_percent"],
        "cpu_model": cpu_ram["cpu_model"],
        "cpu_temp_c": cpu_ram["cpu_temp_c"],
        "cpu_count": os.cpu_count(),
        "ram_used_bytes": cpu_ram["ram_used_bytes"],
        "ram_total_bytes": cpu_ram["ram_total_bytes"],
        "ram_percent": cpu_ram["ram_percent"],
        "gpu": gpu,
        "disk": disk,
        "encode": encode,
    }


@router.get("/activity")
def system_activity():
    """Live + recent background tasks (ffmpeg, downloads, AI, catalog, …)."""
    from ..services import activity

    snap = activity.snapshot()
    cpu = _cpu_ram().get("cpu_percent")
    return {
        "running": snap["running"],
        "recent": snap["recent"],
        "queued": snap["queued"],
        "cpu_percent": cpu,
    }
