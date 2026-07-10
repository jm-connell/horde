"""Best-effort host resource stats (CPU/RAM/GPU). Keep health ready-check cheap."""

from __future__ import annotations

import platform
import shutil
import subprocess
from typing import Any, Optional

from fastapi import APIRouter

router = APIRouter(prefix="/api/system", tags=["system"])


def _cpu_model() -> Optional[str]:
    try:
        import psutil  # type: ignore

        info = getattr(psutil, "cpu_info", None)
        if callable(info):
            data = info()
            brand = getattr(data, "brand_raw", None) or getattr(data, "brand", None)
            if brand:
                return str(brand).strip() or None
    except Exception:  # noqa: BLE001
        pass
    try:
        # Windows / generic fallback
        name = platform.processor()
        return name.strip() or None
    except Exception:  # noqa: BLE001
        return None


def _cpu_temp() -> Optional[float]:
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
    except Exception:  # noqa: BLE001
        pass
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
    except Exception:  # noqa: BLE001
        pass
    return out


def _nvidia_gpu() -> Optional[dict[str, Any]]:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=2.5,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        line = result.stdout.strip().splitlines()[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            return None

        def _num(raw: str) -> Optional[float]:
            try:
                return float(raw)
            except ValueError:
                return None

        util = _num(parts[0])
        temp = _num(parts[1])
        mem_used_mib = _num(parts[2])
        mem_total_mib = _num(parts[3])
        name = parts[4] if len(parts) > 4 else None
        return {
            "name": name,
            "util_percent": util,
            "temp_c": temp,
            "vram_used_bytes": int(mem_used_mib * 1024 * 1024)
            if mem_used_mib is not None
            else None,
            "vram_total_bytes": int(mem_total_mib * 1024 * 1024)
            if mem_total_mib is not None
            else None,
        }
    except Exception:  # noqa: BLE001
        return None


@router.get("/stats")
def system_stats():
    cpu_ram = _cpu_ram()
    gpu = _nvidia_gpu()
    disk = None
    try:
        from ..config import DOWNLOADS_DIR

        usage = shutil.disk_usage(DOWNLOADS_DIR)
        disk = {
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
        }
    except Exception:  # noqa: BLE001
        pass
    return {
        "cpu_percent": cpu_ram["cpu_percent"],
        "cpu_model": cpu_ram["cpu_model"],
        "cpu_temp_c": cpu_ram["cpu_temp_c"],
        "ram_used_bytes": cpu_ram["ram_used_bytes"],
        "ram_total_bytes": cpu_ram["ram_total_bytes"],
        "ram_percent": cpu_ram["ram_percent"],
        "gpu": gpu,
        "disk": disk,
    }
