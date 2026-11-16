"""Resolve ffmpeg/ffprobe binaries (prefer jellyfin-ffmpeg when present)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

_JELLYFIN_FFMPEG = Path("/usr/lib/jellyfin-ffmpeg/ffmpeg")
_JELLYFIN_FFPROBE = Path("/usr/lib/jellyfin-ffmpeg/ffprobe")


def _executable(path: str | Path) -> bool:
    try:
        p = Path(path)
        return p.is_file() and os.access(p, os.X_OK)
    except OSError:
        return False


def ffmpeg_bin() -> str:
    env = (os.environ.get("FFMPEG_BIN") or os.environ.get("FFMPEG_PATH") or "").strip()
    if env and _executable(env):
        return env
    if _executable(_JELLYFIN_FFMPEG):
        return str(_JELLYFIN_FFMPEG)
    found = shutil.which("ffmpeg")
    return found or "ffmpeg"


def ffprobe_bin() -> str:
    env = (
        os.environ.get("FFPROBE_BIN") or os.environ.get("FFPROBE_PATH") or ""
    ).strip()
    if env and _executable(env):
        return env
    ffmpeg = ffmpeg_bin()
    sibling = Path(ffmpeg).with_name("ffprobe")
    if ffmpeg not in {"ffmpeg", ""} and _executable(sibling):
        return str(sibling)
    if _executable(_JELLYFIN_FFPROBE):
        return str(_JELLYFIN_FFPROBE)
    found = shutil.which("ffprobe")
    return found or "ffprobe"


def below_playback(cmd: list[str]) -> list[str]:
    """Prefix ``nice -n 15`` so background work yields CPU to playback.

    Raising niceness needs no privileges, and ``nice`` execs the command, so a
    timeout or process-group kill still reaches ffmpeg. Unchanged where there
    is no ``nice`` (non-POSIX, or a minimal image without coreutils).
    """
    if os.name != "posix" or shutil.which("nice") is None:
        return cmd
    return ["nice", "-n", "15", *cmd]


def ffmpeg_available() -> bool:
    path = ffmpeg_bin()
    if _executable(path):
        return True
    return shutil.which(path) is not None
