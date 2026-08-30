"""Shared yt-dlp format / quality preset helpers."""

from __future__ import annotations

from typing import Any, Optional

# Audio-only bitrate caps (kbps). Shown as labeled presets when the source has audio.
AUDIO_ABR_TIERS: tuple[int, ...] = (160, 128, 64)

# YouTube's "best" video is often VP9 (higher vbr) unless we prefer AV1.
# Pair AV1 with AAC when possible so the MP4 plays on iPhone Safari.
_AV1 = "[vcodec~='^(av01|av1)']"
_AAC = "[acodec~='^(mp4a|aac)']"


def _pair(height_filter: str) -> str:
    """Video+audio selector: AV1+AAC first, then AV1, then any at this height."""
    h = height_filter
    return (
        f"bv*{h}{_AV1}+ba{_AAC}/"
        f"bv*{h}{_AV1}+ba/"
        f"bv*{h}+ba{_AAC}/"
        f"bv*{h}+ba/"
        f"b{h}"
    )


QUALITY_FORMATS = {
    "best": _pair(""),
    # Prefer exact tier height when offered, then best under the cap — never unbounded best.
    "2160p": _pair("[height=2160]") + "/" + _pair("[height<=2160]"),
    "1440p": _pair("[height=1440]") + "/" + _pair("[height<=1440]"),
    "1080p": _pair("[height=1080]") + "/" + _pair("[height<=1080]"),
    "720p": _pair("[height=720]") + "/" + _pair("[height<=720]"),
    "480p": _pair("[height=480]") + "/" + _pair("[height<=480]"),
    "audio": f"ba{_AAC}/ba/b",
    **{
        f"audio-{abr}": (
            f"ba{_AAC}[abr<={abr}]/ba[abr<={abr}]/"
            f"bestaudio[abr<={abr}]/ba/b"
        )
        for abr in AUDIO_ABR_TIERS
    },
}

PRESET_MAX_HEIGHT: dict[str, Optional[int]] = {
    "best": None,
    "2160p": 2160,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "audio": None,
    **{f"audio-{abr}": None for abr in AUDIO_ABR_TIERS},
}

STANDARD_HEIGHTS = (2160, 1440, 1080, 720, 480)

# Must match download YoutubeDL opts so preview sizes pick the same stream.
# vcodec:av01 beats a fatter VP9/H.264 at the same height; AAC for iPhone MP4.
FORMAT_SORT = ["res", "fps", "hdr:12", "vcodec:av01", "acodec:mp4a", "vbr", "abr"]


def is_audio_preset(preset: str) -> bool:
    return preset == "audio" or preset.startswith("audio-")


def format_chain(preset: str) -> list[str]:
    """Build yt-dlp format selectors. Height-capped presets never fall back to unbounded best."""
    primary = QUALITY_FORMATS.get(preset, QUALITY_FORMATS["best"])
    max_h = PRESET_MAX_HEIGHT.get(preset)
    chain = [primary]
    if max_h:
        chain.append(
            f"best[vcodec^=av01][height<={max_h}]/"
            f"best[ext=mp4][height<={max_h}]/"
            f"best[height<={max_h}]"
        )
    elif preset == "best":
        chain.append("best[vcodec^=av01]/best[ext=mp4]/best")
    elif is_audio_preset(preset):
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


def audio_abrs(info: dict[str, Any]) -> list[float]:
    """Collect known audio bitrates (kbps) from format metadata."""
    abrs: list[float] = []
    for fmt in info.get("formats") or []:
        if fmt.get("acodec") in (None, "none"):
            continue
        raw = fmt.get("abr")
        if raw is None and fmt.get("vcodec") in (None, "none"):
            raw = fmt.get("tbr")
        if raw is None:
            continue
        try:
            abr = float(raw)
        except (TypeError, ValueError):
            continue
        if abr > 0:
            abrs.append(abr)
    return abrs


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
        abrs = audio_abrs(info)
        best_abr = max(abrs) if abrs else None
        if best_abr is None:
            # No abr metadata — still offer the standard caps.
            presets.extend(f"audio-{abr}" for abr in AUDIO_ABR_TIERS)
        else:
            for abr in AUDIO_ABR_TIERS:
                # Skip caps at/above the best known stream — "audio" already covers that.
                if best_abr <= abr:
                    continue
                presets.append(f"audio-{abr}")
    return presets


# Underscore aliases for existing call sites / tests.
_video_heights = video_heights
_has_audio = has_audio
_height_to_tier = height_to_tier
_available_presets = available_presets
_is_audio_preset = is_audio_preset
