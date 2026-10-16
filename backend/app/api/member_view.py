"""What a non-administrator sees of the server's internals.

Members get coarse state: booleans, counts and statuses such as ``"error"``.
Provider addresses, model names, GPU details, file paths and raw exception
text (which can quote an internal URL or a key fragment) stay with the
administrator. Every response that carries such a field passes through one of
these helpers for a member; ``api/ai.py`` keeps the AI status equivalent
(``_member_view``) next to its long field list.

A field a member screen shows as an error keeps a generic message, so the
screen still says something went wrong without quoting the server.
"""

from __future__ import annotations

from typing import Any

from ..schemas import CompatState, VideoRead

#: Shown instead of the embedding error (which quotes the provider URL).
EMBED_ERROR = "AI indexing failed"
#: Shown instead of the ffmpeg / yt-dlp text when an H.264 copy fails.
COMPAT_ERROR = "the server could not convert this video"
#: Shown instead of the yt-dlp message of the last failed extract.
EXTRACT_ERROR = "Extraction failed"


def compat(state: CompatState) -> CompatState:
    if state.error is None:
        return state
    return state.model_copy(update={"error": COMPAT_ERROR})


def video(read: VideoRead) -> VideoRead:
    """Embedding error, summary model and cost, and compat error text."""
    return read.model_copy(
        update={
            "embed_error": EMBED_ERROR if read.embed_error else None,
            "ai_summary_model": None,
            "ai_summary_cost": None,
            "compat": compat(read.compat) if read.compat is not None else None,
        }
    )


def activity(payload: dict[str, Any]) -> dict[str, Any]:
    """Background tasks without engine, detail (model names) or error text."""

    def task(row: dict[str, Any]) -> dict[str, Any]:
        return {**row, "engine": None, "detail": None, "error": None}

    return {
        **payload,
        "running": [task(row) for row in payload.get("running") or []],
        "recent": [task(row) for row in payload.get("recent") or []],
    }


def stats(payload: dict[str, Any]) -> dict[str, Any]:
    """Host stats without the GPU's name and memory or the ffmpeg path.

    Whether a GPU encoder is usable stays: the Library tab's playback
    compatibility panel shows it to everyone.
    """
    trimmed = dict(payload)
    if trimmed.get("gpu"):
        trimmed["gpu"] = {
            **trimmed["gpu"],
            "name": None,
            "vram_used_bytes": None,
            "vram_total_bytes": None,
        }
    if trimmed.get("encode"):
        trimmed["encode"] = {**trimmed["encode"], "gpu_name": None, "ffmpeg_bin": None}
    return trimmed


def health(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop provider internals (addresses, models, OpenRouter setup, error texts)."""
    trimmed = dict(payload)
    if trimmed.get("ollama"):
        trimmed["ollama"] = {
            **trimmed["ollama"],
            "base_url": None,
            "last_error": None,
            "pulling": None,
        }
    # Only the administrator's Settings > System shows the OpenRouter setup.
    trimmed["openrouter"] = None
    if trimmed.get("pot_provider"):
        trimmed["pot_provider"] = {
            **trimmed["pot_provider"],
            "url": None,
            "detail": None,
        }
    youtube = trimmed.get("youtube")
    if youtube and youtube.get("last_extract_failure"):
        trimmed["youtube"] = {
            **youtube,
            "last_extract_failure": {
                **youtube["last_extract_failure"],
                "message": EXTRACT_ERROR,
                "target": None,
                "url": None,
            },
        }
    if trimmed.get("workers"):
        trimmed["workers"] = {**trimmed["workers"], "ai_blocked_reason": None}
    return trimmed
