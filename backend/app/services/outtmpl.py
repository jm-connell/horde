"""yt-dlp output templates that stay inside filesystem limits.

Linux caps a path *component* at 255 bytes (not characters), so a title of
4-byte emoji plus ``[id]`` plus yt-dlp's ``.f137.mp4.part`` suffix overflows
with ``ENAMETOOLONG``. Users also browse the library over SMB from Windows,
which rejects trailing dots/spaces and reserved device names. Templates built
here byte-truncate every free-text field and are verified against yt-dlp's own
rendering before use.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .paths import safe_filename

logger = logging.getLogger(__name__)

TITLE_BYTES = 150
FOLDER_BYTES = 80
ID_BYTES = 64
UNKNOWN_FOLDER = "Unknown channel"
UNKNOWN_YEAR = "Unknown year"
UNTITLED = "Untitled"

MAX_COMPONENT_BYTES = 255
# Longest suffix appended to a final file name by yt-dlp or Horde:
#   ".f251-drc.webm.part-Frag12", ".horde-h264.dl", ".norm.<thread>.mp4".
NAME_SUFFIX_RESERVE = 40
_TITLE_BUDGETS = (TITLE_BYTES, 120, 90, 60, 40, 20)


def _escape(text: str) -> str:
    """Escape ``%`` so literal text survives yt-dlp template expansion."""
    return text.replace("%", "%%")


def channel_folder(info: Mapping[str, Any], channel_override: str | None = None) -> str:
    """Folder name for a download: the channel the library row will carry.

    Mirrors how ``_complete_download`` picks ``Video.channel`` (override first,
    then ``uploader``/``channel``) so the folder and the DB agree. A missing
    uploader gets a readable folder instead of yt-dlp's ``NA``.
    """
    from yt_dlp.utils import sanitize_filename

    raw = (
        (channel_override or "").strip()
        or str(info.get("uploader") or "").strip()
        or str(info.get("channel") or "").strip()
        or str(info.get("uploader_id") or "").strip()
    )
    # Same sanitizer yt-dlp applies to a %(uploader)s field, so existing
    # folders keep their names ("AC/DC" -> "AC⧸DC").
    name = sanitize_filename(raw) if raw else ""
    return safe_filename(name, max_bytes=FOLDER_BYTES, default=UNKNOWN_FOLDER)


def library_outtmpl(root: Path, folder: str, title_bytes: int = TITLE_BYTES) -> str:
    return (
        f"{_escape(str(root))}/{_escape(folder)}"
        f"/%(upload_date>%Y|{UNKNOWN_YEAR})s"
        f"/%(title|{UNTITLED}).{title_bytes}B [%(id).{ID_BYTES}B].%(ext)s"
    )


def flat_outtmpl(directory: Path, title_bytes: int = TITLE_BYTES) -> str:
    """Template for a single directory (ephemeral device downloads)."""
    return (
        f"{_escape(str(directory))}"
        f"/%(title|{UNTITLED}).{title_bytes}B [%(id).{ID_BYTES}B].%(ext)s"
    )


def windows_filenames_ok(root: Path) -> bool:
    """True when forcing yt-dlp's Windows path rules cannot mangle ``root``.

    ``windowsfilenames`` sanitises the whole joined path, including the
    downloads directory. A root with ``:`` or a trailing dot would be rewritten
    to something else, so in that case the rules are left off.
    """
    from yt_dlp.utils import sanitize_path

    text = str(root)
    return bool(sanitize_path(text, force=True) == text)


def fit_outtmpl(
    make: Callable[[int], str],
    info: Mapping[str, Any],
    *,
    windowsfilenames: bool,
) -> str:
    """Shrink the title budget until the rendered file name leaves suffix room.

    ``%(title).150BS`` is not expressible: yt-dlp truncates bytes first and
    sanitises second, and sanitising can expand a character 3x (``:`` becomes a
    3-byte full-width colon). Rendering with yt-dlp itself is the only reliable
    check that the *final* name fits.
    """
    import yt_dlp

    limit = MAX_COMPONENT_BYTES - NAME_SUFFIX_RESERVE
    ydl = yt_dlp.YoutubeDL(
        {"quiet": True, "no_warnings": True, "windowsfilenames": windowsfilenames}
    )
    try:
        for budget in _TITLE_BUDGETS:
            tmpl = make(budget)
            rendered = ydl.prepare_filename(dict(info), outtmpl=tmpl)
            if rendered and len(os.fsencode(os.path.basename(rendered))) <= limit:
                return tmpl
    except Exception:
        logger.warning("could not verify output template length", exc_info=True)
        return make(_TITLE_BUDGETS[-1])
    finally:
        ydl.close()
    return make(_TITLE_BUDGETS[-1])
