"""Detect a data directory on a network filesystem (where SQLite WAL is unsafe).

SQLite's write-ahead log relies on shared memory and POSIX locks that NFS, SMB and
FUSE network mounts do not provide reliably. A database there can be corrupted
without any error, so Horde warns loudly at startup and in ``/api/health``.
Linux only: the check reads ``/proc/self/mountinfo`` and finds nothing elsewhere.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

MOUNTINFO_PATH = Path("/proc/self/mountinfo")

#: Filesystem types where WAL locking and shared memory cannot be trusted.
NETWORK_FILESYSTEMS = frozenset(
    {"nfs", "nfs4", "cifs", "smb3", "smbfs", "9p", "fuse.sshfs"}
)

_OCTAL_ESCAPE = re.compile(r"\\([0-7]{3})")


def _unescape(field: str) -> str:
    """mountinfo writes space, tab, newline and backslash as octal escapes."""
    return _OCTAL_ESCAPE.sub(lambda m: chr(int(m.group(1), 8)), field)


def parse_mountinfo(text: str) -> list[tuple[str, str]]:
    """``(mount point, filesystem type)`` for every line of a mountinfo file."""
    mounts: list[tuple[str, str]] = []
    for line in text.splitlines():
        left, sep, right = line.partition(" - ")
        fields = left.split()
        after = right.split()
        if not sep or len(fields) < 5 or not after:
            continue
        mounts.append((_unescape(fields[4]), after[0]))
    return mounts


def filesystem_of(path: Path, mounts: list[tuple[str, str]]) -> tuple[str, str] | None:
    """The mount containing ``path``: the longest mount point that prefixes it."""
    target = path.as_posix()
    best: tuple[str, str] | None = None
    for mount_point, fstype in mounts:
        prefix = mount_point.rstrip("/")
        inside = target in (mount_point, prefix) or target.startswith(prefix + "/")
        if inside and (best is None or len(mount_point) >= len(best[0])):
            best = (mount_point, fstype)
    return best


def network_storage_warning(
    data_dir: Path, mountinfo: Path = MOUNTINFO_PATH
) -> str | None:
    """A human-readable warning when ``data_dir`` is on a network filesystem."""
    try:
        text = mountinfo.read_text(encoding="utf-8", errors="replace")
    except OSError:
        logger.debug("cannot read %s; skipping storage check", mountinfo)
        return None
    found = filesystem_of(data_dir.resolve(), parse_mountinfo(text))
    if found is None or found[1] not in NETWORK_FILESYSTEMS:
        return None
    mount_point, fstype = found
    return (
        f"The data directory {data_dir} is on a network filesystem ({fstype} mounted "
        f"at {mount_point}). SQLite's write-ahead log (WAL) is not safe there and the "
        "library database can be corrupted. Keep DATA_DIR on local disk; only the "
        "downloads folder should live on network storage."
    )
