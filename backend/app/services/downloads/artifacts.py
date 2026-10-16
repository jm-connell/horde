"""Finding, validating and cleaning up the files yt-dlp leaves while it downloads."""

from pathlib import Path

from ...config import VIDEO_EXTENSIONS
from ...context import get_paths
from ..fsutil import safe_rel, safe_unlink
from ..metadata import probe_is_playable
from ..paths import (
    COMPAT_SIDECAR_TOKEN,
    STAGING_FRAGMENT_RE,
    belongs_to_stem,
    video_stem,
)


def is_intermediate_media(name: str) -> bool:
    """True for yt-dlp/ffmpeg sidecars that are not the final library file."""
    low = name.lower()
    if STAGING_FRAGMENT_RE.search(name) or low.endswith(".part"):
        return True
    if ".temp." in low or low.endswith(".temp.mp4"):
        return True
    if ".norm." in low or low.endswith(".norm.mp4"):
        return True
    if ".compat." in low or low.endswith(".compat.mp4"):
        return True
    return bool(".xcode." in low or low.endswith(".xcode.mp4"))


def find_merged_video(prepared: Path) -> Path | None:
    """Locate the final merged video when yt-dlp errors on fragment cleanup."""
    mp4 = prepared.with_suffix(".mp4")
    if mp4.exists() and not is_intermediate_media(mp4.name):
        return mp4
    if (
        prepared.exists()
        and prepared.suffix.lower() in VIDEO_EXTENSIONS
        and not is_intermediate_media(prepared.name)
    ):
        return prepared

    parent = prepared.parent
    stem = video_stem(prepared, staging=True)
    best: Path | None = None
    best_size = 0
    if not parent.is_dir():
        return None
    for entry in parent.iterdir():
        if not entry.is_file():
            continue
        if not belongs_to_stem(entry.name, stem):
            continue
        if entry.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        if is_intermediate_media(entry.name):
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            continue
        if size > best_size:
            best_size = size
            best = entry
    return best


def resolve_merged_video(prepared: Path | None, active_paths: set[str]) -> Path | None:
    if prepared is not None:
        found = find_merged_video(prepared)
        if found is not None:
            return found
    for rel in active_paths:
        found = find_merged_video(get_paths().downloads / rel)
        if found is not None:
            return found
    return None


def validate_playable(path: Path) -> bool:
    """Return True when the file is a complete, decodable video."""
    return probe_is_playable(path)


def cleanup_download_artifacts(paths: set[str], *, remove_final: bool = False) -> None:
    """Remove in-progress fragments and optionally corrupt final files."""
    for rel in paths:
        full = get_paths().downloads / rel
        parent = full.parent
        stem = video_stem(full, staging=True)
        if not parent.is_dir():
            continue
        for entry in parent.iterdir():
            if not entry.is_file() or not belongs_to_stem(entry.name, stem):
                continue
            if entry.name.endswith(".part") or STAGING_FRAGMENT_RE.search(entry.name):
                safe_unlink(entry)
                continue
            if (
                remove_final
                and entry.suffix.lower() in VIDEO_EXTENSIONS
                and STAGING_FRAGMENT_RE.search(entry.name) is None
                and COMPAT_SIDECAR_TOKEN not in entry.name
            ):
                safe_unlink(entry)


def cleanup_partial_files(paths: set[str]) -> None:
    """Remove in-progress fragments; also drop unplayable merged files left by cancel."""
    cleanup_download_artifacts(paths, remove_final=False)
    for rel in paths:
        full = get_paths().downloads / rel
        if not full.is_file():
            continue
        if STAGING_FRAGMENT_RE.search(full.name) or full.name.endswith(".part"):
            continue
        if full.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        if not validate_playable(full):
            safe_unlink(full)


def reject_unplayable(path: Path | None, attempt_paths: set[str]) -> Path | None:
    """Return path if playable; otherwise remove corrupt artifacts and return None."""
    if path is None or not path.exists() or path.stat().st_size <= 0:
        return None
    if validate_playable(path):
        return path
    rel = safe_rel(path)
    if rel:
        cleanup_download_artifacts({rel}, remove_final=True)
    cleanup_partial_files(attempt_paths)
    return None
