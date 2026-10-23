"""Best-effort host resource stats (CPU/RAM/GPU). Keep health ready-check cheap."""

from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlmodel import Session

from ..auth import current_user, require_admin
from ..context import get_ctx, get_paths, get_session
from ..response_schemas import SystemStatsRead, UpdateControlRead
from ..schemas import SecurityChecklistRead, SystemActivityRead
from ..services import (
    app_settings,
    security_checklist,
    update_control,
    updates,
    url_safety,
)
from ..services.auth import two_factor
from ..services.auth.accounts import AuthUser
from ..services.auth.runtime import AuthRuntime
from . import member_view

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
            import winreg

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
        import psutil

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
        import psutil

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


@router.get("/stats", response_model=SystemStatsRead)
def system_stats(user: AuthUser = Depends(current_user)):
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
        usage = shutil.disk_usage(get_paths().downloads)
        disk = {
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
        }
    except Exception:
        # The Settings page polls this endpoint.
        logger.debug(
            "could not read disk usage of %s", get_paths().downloads, exc_info=True
        )
    payload = {
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
    return payload if user.is_admin else member_view.stats(payload)


@router.get("/activity", response_model=SystemActivityRead)
def system_activity(user: AuthUser = Depends(current_user)):
    """Live + recent background tasks (ffmpeg, downloads, AI, catalog, …)."""
    from ..services import activity

    snap = activity.snapshot()
    cpu = _cpu_ram().get("cpu_percent")
    payload = {
        "running": snap["running"],
        "recent": snap["recent"],
        "queued": snap["queued"],
        "cpu_percent": cpu,
    }
    return payload if user.is_admin else member_view.activity(payload)


# --- "Update now" (scripts/update_watch.sh does the work on the host) --------


@router.get(
    "/update",
    response_model=UpdateControlRead,
    dependencies=[Depends(require_admin)],
)
def update_status():
    """Whether the update button is set up on the host, and the last/current run."""
    return update_control.read_status(get_paths().data)


@router.post(
    "/update",
    response_model=UpdateControlRead,
    dependencies=[Depends(require_admin)],
)
def start_update(user: AuthUser = Depends(current_user)):
    """Ask the host to run update.sh (picked up within about a minute)."""
    return update_control.request_update(get_paths().data, user.username)


@router.post(
    "/update/cancel",
    response_model=UpdateControlRead,
    dependencies=[Depends(require_admin)],
)
def cancel_update():
    """Withdraw an update request the host has not started yet."""
    return update_control.cancel_request(get_paths().data)


# --- Security checklist ------------------------------------------------------------


@router.get(
    "/security-checklist",
    response_model=SecurityChecklistRead,
    dependencies=[Depends(require_admin)],
)
def get_security_checklist(
    request: Request,
    session: Session = Depends(get_session),
):
    """Pass/warn lines about how this server is exposed (for the Settings → System card).

    Computed from what the process knows: this request, the proxy and host settings,
    the two-step requirement, which administrators have it, the environment switches
    and the cached update check.
    """
    from ..security import HostPolicy

    runtime: AuthRuntime = request.app.state.auth
    policy: HostPolicy = request.app.state.host_policy
    lan_only = HostPolicy()
    forwarded = ("x-forwarded-for", "x-forwarded-proto", "x-forwarded-host")
    update_info = updates.check_for_updates(offline=get_ctx(request).e2e)
    update_available: bool | None = None
    if update_info.get("update_available"):
        update_available = True
    elif update_info.get("latest_sha"):
        update_available = False
    facts = security_checklist.Facts(
        https=runtime.is_https(request),
        trust_proxy=runtime.config.trust_proxy,
        proxied=any(name in request.headers for name in forwarded),
        public_hosts=tuple(h for h in policy.extra if not lan_only.allows(h)),
        any_host=policy.allow_any,
        require_two_factor=two_factor.normalize_requirement(
            app_settings.load().get("require_two_factor")
        ),
        admins_without_two_factor=tuple(two_factor.admins_without(session)),
        auth_disabled=runtime.config.disabled,
        allow_private_urls=url_safety.allow_private_urls(),
        update_available=update_available,
    )
    return security_checklist.evaluate(facts)
