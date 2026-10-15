import re
from pathlib import Path

from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR
from ..models import Video

_YT_ID_IN_PATH = re.compile(r"\[([A-Za-z0-9_-]{11})\]")

# Hidden per-job download staging under DOWNLOADS_DIR (never scanned or served).
STAGING_DIR_NAME = ".horde-staging"

# yt-dlp appends ``.f<format_id>`` before the container extension of every
# per-format download that still has to be merged (``Title [id].f137.mp4``,
# ``Title [id].f251-drc.webm``, ``Title [id].fhls-1080p.mp4``). Format ids are
# arbitrary tokens, so outside of a digits-only id the suffix is only trusted
# directly after the ``[id]`` token that the output template always writes.
_AFTER_ID_BRACKET = r"(?<=\])"
_FORMAT_SUFFIX = rf"(?:\.f\d+(?:-[A-Za-z0-9_]+)*|{_AFTER_ID_BRACKET}\.f[^.\s/\\]+)"
FORMAT_SUFFIX_RE = re.compile(_FORMAT_SUFFIX + r"$")
# A name that is a per-format fragment: stem + format suffix + extension.
FRAGMENT_RE = re.compile(_FORMAT_SUFFIX + r"\.[^.]+$")

# Everything that may follow a video's stem for the files that belong to it:
# dot-separated tokens only (``.f137.mp4.part``, ``.en.vtt``, ``.horde-h264.mp4``).
# A space or bracket after the stem means a *different* video that merely
# starts with the same text.
_STEM_SUFFIX_RE = re.compile(r"(?:\.[^.\s/\\\[\]]+)+")

# "<stem>.horde-h264.mp4" beside the original; the scanner ignores the token.
COMPAT_SIDECAR_TOKEN = ".horde-h264."  # noqa: S105 - filename marker, not a secret


def compat_sidecar_path(original: Path) -> Path:
    """Where the ≤1080p H.264 compatibility copy of ``original`` lives."""
    return original.with_name(f"{original.stem}{COMPAT_SIDECAR_TOKEN}mp4")


def resolve_compat_path(video: Video) -> Path | None:
    """Absolute sidecar path when the row has one inside DOWNLOADS_DIR."""
    if not video.compat_path:
        return None
    root = DOWNLOADS_DIR.resolve()
    path = (root / video.compat_path).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path


def video_stem(path: Path | str) -> str:
    """The shared stem of a download and its sidecars.

    Drops the container extension and a trailing yt-dlp format suffix only:
    ``Title [id].f137.mp4`` -> ``Title [id]``. A ``.f`` elsewhere in a title
    (``Learn.fast tricks [id]``, ``www.facebook.com [id]``) is left alone.
    """
    stem = Path(path).stem
    return FORMAT_SUFFIX_RE.sub("", stem, count=1) or stem


def belongs_to_stem(name: str, stem: str) -> bool:
    """True when file ``name`` is ``stem`` plus only dot-separated suffix tokens.

    This is an exact match on the full stem, never a ``startswith`` prefix scan:
    ``Learn [a].mp4`` does not belong to ``Learn`` or to ``Learn [ab]``.
    """
    if not stem or not name.startswith(stem):
        return False
    rest = name[len(stem) :]
    return rest == "" or _STEM_SUFFIX_RE.fullmatch(rest) is not None


def is_staging_rel_path(rel_path: str) -> bool:
    posix = (rel_path or "").replace("\\", "/").lstrip("/")
    return posix == STAGING_DIR_NAME or posix.startswith(f"{STAGING_DIR_NAME}/")


def to_rel_path(path: Path) -> str:
    """Store paths with forward slashes so DB keys are stable on Windows."""
    return path.resolve().relative_to(DOWNLOADS_DIR.resolve()).as_posix()


def find_video_by_path(session: Session, rel_path: str) -> Video | None:
    """Look up a video by relative path (handles legacy backslash rows)."""
    posix = rel_path.replace("\\", "/")
    for candidate in {posix, rel_path, posix.replace("/", "\\")}:
        row = session.exec(select(Video).where(Video.file_path == candidate)).first()
        if row is not None:
            return row
    return None


def safe_filename(name: str) -> str:
    """Strip characters that break filesystems or Content-Disposition."""
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return cleaned or "video"


def is_manual_import(video: Video) -> bool:
    """True for scanner/upload imports (not yt-dlp downloads)."""
    if video.source_url:
        return False
    return not _YT_ID_IN_PATH.search(video.file_path or "")


def manual_import_rel_path(channel: str | None, title: str, ext: str) -> str:
    """Build Channel/Title.ext or imports/Title.ext for a manual import."""
    safe_title = safe_filename(title)
    suffix = ext if ext.startswith(".") else f".{ext}"
    if channel and channel.strip():
        return f"{safe_filename(channel.strip())}/{safe_title}{suffix}"
    return f"imports/{safe_title}{suffix}"


def unique_rel_path(desired: str, *, exclude: str | None = None) -> str:
    """Return desired if free on disk; otherwise append ' (2)', ' (3)', …"""
    root = DOWNLOADS_DIR.resolve()
    posix = desired.replace("\\", "/")
    path = Path(posix)
    stem = path.stem
    suffix = path.suffix
    parent = path.parent

    candidate = posix
    n = 2
    while True:
        if exclude and candidate.replace("\\", "/") == exclude.replace("\\", "/"):
            return candidate
        abs_path = (root / candidate).resolve()
        try:
            abs_path.relative_to(root)
        except ValueError:
            raise ValueError("Path escapes downloads directory") from None
        if not abs_path.exists():
            return candidate
        candidate = (parent / f"{stem} ({n}){suffix}").as_posix()
        n += 1


def rename_video_file(session: Session, video: Video, new_rel: str) -> None:
    """Move the on-disk file and update video.file_path. Caller commits."""
    root = DOWNLOADS_DIR.resolve()
    old_rel = video.file_path.replace("\\", "/")
    new_rel = unique_rel_path(new_rel.replace("\\", "/"), exclude=old_rel)

    if new_rel == old_rel:
        return

    old_abs = (root / old_rel).resolve()
    new_abs = (root / new_rel).resolve()
    try:
        old_abs.relative_to(root)
        new_abs.relative_to(root)
    except ValueError as exc:
        raise ValueError("Path escapes downloads directory") from exc

    if not old_abs.is_file():
        raise FileNotFoundError(f"Source file missing: {old_rel}")

    new_abs.parent.mkdir(parents=True, exist_ok=True)
    old_abs.replace(new_abs)
    video.file_path = new_rel
    old_compat = resolve_compat_path(video)
    if old_compat is not None and old_compat.is_file():
        new_compat = compat_sidecar_path(new_abs)
        try:
            old_compat.replace(new_compat)
            video.compat_path = new_compat.relative_to(root).as_posix()
        except OSError:
            pass
    session.add(video)
