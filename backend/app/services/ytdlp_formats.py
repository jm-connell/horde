"""Shared yt-dlp format / quality preset helpers."""

from __future__ import annotations

from typing import Any, Optional

QUALITY_FORMATS = {
    "best": "bv*+ba/b",
    # Prefer exact tier height when offered, then best under the cap — never unbounded best.
    "2160p": (
        "bv*[height=2160]+ba/bv*[height<=2160]+ba/"
        "b[height=2160]/b[height<=2160]"
    ),
    "1440p": (
        "bv*[height=1440]+ba/bv*[height<=1440]+ba/"
        "b[height=1440]/b[height<=1440]"
    ),
    "1080p": (
        "bv*[height=1080]+ba/bv*[height<=1080]+ba/"
        "b[height=1080]/b[height<=1080]"
    ),
    "720p": (
        "bv*[height=720]+ba/bv*[height<=720]+ba/"
        "b[height=720]/b[height<=720]"
    ),
    "480p": (
        "bv*[height=480]+ba/bv*[height<=480]+ba/"
        "b[height=480]/b[height<=480]"
    ),
    "audio": "ba/b",
}

PRESET_MAX_HEIGHT: dict[str, Optional[int]] = {
    "best": None,
    "2160p": 2160,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "audio": None,
}

STANDARD_HEIGHTS = (2160, 1440, 1080, 720, 480)


def format_chain(preset: str) -> list[str]:
    """Build yt-dlp format selectors. Height-capped presets never fall back to unbounded best."""
    primary = QUALITY_FORMATS.get(preset, QUALITY_FORMATS["best"])
    max_h = PRESET_MAX_HEIGHT.get(preset)
    chain = [primary]
    if max_h:
        chain.append(f"best[ext=mp4][height<={max_h}]/best[height<={max_h}]")
    elif preset == "best":
        chain.append("best[ext=mp4]/best")
    elif preset == "audio":
        chain.append("bestaudio/best")
    unique: list[str] = []
    seen: set[str] = set()
    for fmt in chain:
        if fmt not in seen:
            seen.add(fmt)
            unique.append(fmt)
    return unique


# Back-compat alias used inside downloader historically.
_format_chain = format_chain


def video_heights(info: dict[str, Any]) -> set[int]:
    heights: set[int] = set()
    for fmt in info.get("formats") or []:
        height = fmt.get("height")
        if height and fmt.get("vcodec") not in (None, "none"):
            heights.add(int(height))
    return heights


def has_audio(info: dict[str, Any]) -> bool:
    for fmt in info.get("formats") or []:
        if fmt.get("acodec") not in (None, "none"):
            return True
    return False


def height_to_tier(height: int) -> int:
    """Map an actual pixel height to the nearest standard quality tier."""
    best = STANDARD_HEIGHTS[-1]
    best_dist = abs(height - best)
    for tier in STANDARD_HEIGHTS:
        dist = abs(height - tier)
        if dist < best_dist or (dist == best_dist and tier > best):
            best = tier
            best_dist = dist
    return best


def available_presets(info: dict[str, Any]) -> list[str]:
    """Return resolution presets present in source, highest first, then audio."""
    heights = video_heights(info)
    tiers_present = {height_to_tier(h) for h in heights}
    presets: list[str] = []
    for tier in STANDARD_HEIGHTS:
        if tier in tiers_present:
            presets.append(f"{tier}p")
    if has_audio(info):
        presets.append("audio")
    return presets


# Underscore aliases for existing call sites / tests.
_video_heights = video_heights
_has_audio = has_audio
_height_to_tier = height_to_tier
_available_presets = available_presets
