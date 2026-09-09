"""Shared yt-dlp format / quality preset helpers."""

from __future__ import annotations

import json
import re
from typing import Any, Optional

# Audio-only bitrate caps (kbps). Shown as labeled presets when the source has audio.
AUDIO_ABR_TIERS: tuple[int, ...] = (160, 128, 64)

# Prefer AV1 + AAC so archives stay 4K/HDR and remux to a Safari-playable MP4
# without an H.264 transcode. VP9 often wins on raw vbr otherwise.
_AV1 = "[vcodec~='^(av01|av1)']"
_H264 = "[vcodec~='^(avc1|avc|h264)']"
_AAC = "[acodec~='^(mp4a|aac)']"

VIDEO_CODECS = ("av1", "h264", "h265")


def normalize_video_codec(value: Any) -> str:
    raw = str(value or "av1").strip().lower().replace("-", "").replace(".", "")
    if raw in {"h264", "avc", "avc1", "avc3"}:
        return "h264"
    if raw in {"h265", "hevc", "hev1", "hvc1"}:
        return "h265"
    return "av1"


def default_download_video_codec() -> str:
    """UI-blob default for API clients that omit video_codec."""
    try:
        from .app_settings import load

        ui = (load() or {}).get("ui") or {}
        return normalize_video_codec(ui.get("download_video_codec"))
    except Exception:  # noqa: BLE001
        return "av1"


def _pair(height_filter: str, *, h264: bool = False) -> str:
    """Video+audio selector: preferred codec + AAC, then that codec, then any."""
    h = height_filter
    pref = _H264 if h264 else _AV1
    return (
        f"bv*{h}{pref}+ba{_AAC}/"
        f"bv*{h}{pref}+ba/"
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
# lang before abr so dubbed higher-bitrate tracks lose to the original.
FORMAT_SORT = ["res", "fps", "hdr:12", "vcodec:av01", "lang", "acodec:mp4a", "vbr", "abr"]
FORMAT_SORT_H264 = ["res", "fps", "hdr:12", "vcodec:h264", "lang", "acodec:mp4a", "vbr", "abr"]


def is_audio_preset(preset: str) -> bool:
    return preset == "audio" or preset.startswith("audio-")


def uses_native_h264(preset: str, codec: str) -> bool:
    """True when we should grab YouTube avc1 (≤1080p) instead of AV1-for-transcode."""
    if is_audio_preset(preset):
        return False
    if normalize_video_codec(codec) == "av1":
        return False
    max_h = PRESET_MAX_HEIGHT.get(preset)
    if max_h is None:
        return False
    return max_h <= 1080


def format_sort_for(preset: str, codec: str = "av1") -> list[str]:
    if uses_native_h264(preset, codec):
        return list(FORMAT_SORT_H264)
    return list(FORMAT_SORT)


def _primary_spec(preset: str, *, h264: bool) -> str:
    pair = lambda filt: _pair(filt, h264=h264)
    audio = QUALITY_FORMATS.get(preset) if is_audio_preset(preset) else None
    if audio:
        return audio
    if preset == "best":
        return pair("")
    max_h = PRESET_MAX_HEIGHT.get(preset)
    if max_h:
        return pair(f"[height={max_h}]") + "/" + pair(f"[height<={max_h}]")
    return pair("")


def format_chain(preset: str, codec: str = "av1") -> list[str]:
    """Build yt-dlp format selectors. Height-capped presets never fall back to unbounded best."""
    native = uses_native_h264(preset, codec)
    primary = _primary_spec(preset, h264=native)
    max_h = PRESET_MAX_HEIGHT.get(preset)
    chain = [primary]
    vpref = "avc" if native else "av01"
    if max_h:
        chain.append(
            f"best[vcodec^={vpref}][height<={max_h}]/"
            f"best[ext=mp4][height<={max_h}]/"
            f"best[height<={max_h}]"
        )
    elif is_audio_preset(preset):
        chain.append("bestaudio[acodec~='^(mp4a|aac)']/bestaudio/best")
    elif preset == "best":
        chain.append(f"best[vcodec^={vpref}]/best[ext=mp4]/best")
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


def resolve_quality_preset(preset: str, available: list[str]) -> str:
    """Map ``best`` to the highest concrete video (or audio) tier in ``available``.

    Channel/download UI may request ``best``; the queue stores the resolved
    height so cards show ``4K`` rather than ``Best available``.
    """
    if preset != "best":
        return preset
    if not available:
        return "best"
    present = set(available)
    for tier in STANDARD_HEIGHTS:
        name = f"{tier}p"
        if name in present:
            return name
    if "audio" in present:
        return "audio"
    for abr in AUDIO_ABR_TIERS:
        name = f"audio-{abr}"
        if name in present:
            return name
    return "best"


def encode_available_presets(presets: list[str] | None) -> str | None:
    if not presets:
        return None
    return json.dumps([str(p) for p in presets])


def decode_available_presets(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [str(p) for p in data if p]


def quality_from_preview(requested: str, preview: dict[str, Any] | None) -> tuple[str, str | None]:
    """Return (resolved_preset, encoded available_presets) from a preview dict."""
    available: list[str] = []
    if isinstance(preview, dict):
        raw = preview.get("available_presets") or []
        if isinstance(raw, list):
            available = [str(p) for p in raw if p]
    resolved = resolve_quality_preset(requested or "best", available)
    return resolved, encode_available_presets(available)


def original_language(info: dict[str, Any] | None) -> str:
    if not isinstance(info, dict):
        return ""
    return str(info.get("language") or info.get("original_language") or "").lower()


def _is_mp4_audio_codec(acodec: str) -> bool:
    a = acodec.lower()
    return a.startswith("mp4a") or a in ("aac", "mp4a.40.2", "mp4a.40.5")


def score_audio_format(fmt: dict[str, Any], original_lang: str) -> int:
    """Higher is better. Prefers original language over a fatter dubbed track."""
    score = 0
    abr = fmt.get("abr") or fmt.get("tbr") or 0
    try:
        score += int(float(abr))
    except (TypeError, ValueError):
        pass
    try:
        score += int(fmt.get("asr") or 0) // 100
    except (TypeError, ValueError):
        pass
    acodec = str(fmt.get("acodec") or "")
    if _is_mp4_audio_codec(acodec):
        score += 2_000
    format_id = str(fmt.get("format_id") or "")
    note = str(fmt.get("format_note") or "").lower()
    track = fmt.get("audio_track")
    track_id = ""
    if isinstance(track, dict):
        track_id = str(track.get("id") or "").lower()
        display = str(track.get("display_name") or "").lower()
        note = f"{note} {display}"
    blob = f"{format_id} {note} {track_id}"
    if "-drc" in format_id.lower() or "drc" in note:
        score -= 50_000
    if "dubbed" in blob or "dub " in note:
        score -= 40_000
    lang = str(fmt.get("language") or fmt.get("lang") or "").lower()
    if original_lang and lang == original_lang:
        score += 20_000
    elif "original" in blob:
        score += 15_000
    elif lang in ("", "und") and not original_lang:
        score += 5_000
    elif lang == "en" and not original_lang:
        score += 5_000
    elif lang and original_lang and lang != original_lang:
        score -= 10_000
    return score


def pick_original_audio_format(
    info: dict[str, Any] | None,
    *,
    require_mp4: bool = False,
) -> Optional[dict[str, Any]]:
    """Choose the original-language audio track when YouTube offers autodubs."""
    if not isinstance(info, dict):
        return None
    original_lang = original_language(info)
    candidates: list[tuple[int, dict[str, Any]]] = []
    for fmt in info.get("formats") or []:
        if not isinstance(fmt, dict):
            continue
        vcodec = str(fmt.get("vcodec") or "none")
        acodec = str(fmt.get("acodec") or "none")
        if vcodec != "none" or acodec == "none":
            continue
        if require_mp4:
            ext = str(fmt.get("ext") or "").lower()
            if ext not in ("mp4", "m4a"):
                continue
            if not _is_mp4_audio_codec(acodec):
                continue
            if not fmt.get("url"):
                continue
            if str(fmt.get("format_note") or "").lower().startswith("storyboard"):
                continue
            if fmt.get("protocol") in (
                "mhtml",
                "m3u8",
                "m3u8_native",
                "http_dash_segments",
            ):
                continue
            if fmt.get("fragments"):
                continue
        candidates.append((score_audio_format(fmt, original_lang), fmt))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def apply_audio_format_id(chain: list[str], audio_id: str) -> list[str]:
    """Pin a concrete audio format id in place of ``ba``, not ``bestaudio``."""
    aid = (audio_id or "").strip()
    if not aid:
        return chain
    out: list[str] = []
    ba_plus = re.compile(r"\+ba(?:\[[^\]]*\])?")
    ba_token = re.compile(r"(?<![A-Za-z0-9_+])ba(?![A-Za-z0-9_])(?:\[[^\]]*\])?")
    for spec in chain:
        pinned = ba_plus.sub(f"+{aid}", spec)
        pinned = ba_token.sub(aid, pinned)
        out.append(pinned)
    return out


# Underscore aliases for existing call sites / tests.
_video_heights = video_heights
_has_audio = has_audio
_height_to_tier = height_to_tier
_available_presets = available_presets
_is_audio_preset = is_audio_preset
