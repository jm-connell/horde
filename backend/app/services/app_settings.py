import json
import threading
from pathlib import Path
from typing import Any

_lock = threading.Lock()

AI_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "provider": "ollama",
    "base_url": "",
    "embed_model": "nomic-embed-text",
    "chat_model": "llama3.2:3b",
    # on_download | on_request | timer | set_time
    "schedule": "on_download",
    "timer_hours": 6,
    "schedule_time": "03:00",  # local HH:MM for set_time
    "last_daily_run": "",  # YYYY-MM-DD when set_time last ran
    "auto_pull_models": True,
    "use_subtitles": True,
    "enrich_tags": True,
    "ai_summaries": True,
    "summary_length": "short",  # short | medium | long
    "ai_duplicates": True,
    "category_min_score": 0.55,
    "workload_profile": "normal",  # light | normal | heavy
    # Optional GiB override for the Ollama machine's GPU (null = autodetect).
    "vram_gb": None,
    "pending_category_refresh": False,
    "paused": False,
}

_CATEGORY_MIN_SCORE_LO = 0.20
_CATEGORY_MIN_SCORE_HI = 0.90
_VRAM_GB_LO = 0.5
_VRAM_GB_HI = 256.0
_SUMMARY_LENGTHS = frozenset({"short", "medium", "long"})


def clamp_category_min_score(value: Any) -> float:
    try:
        score = float(value)
    except (TypeError, ValueError):
        score = float(AI_DEFAULTS["category_min_score"])
    return max(_CATEGORY_MIN_SCORE_LO, min(_CATEGORY_MIN_SCORE_HI, score))


def normalize_summary_length(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in _SUMMARY_LENGTHS:
        return raw
    return str(AI_DEFAULTS["summary_length"])


def clamp_vram_gb(value: Any) -> float | None:
    """None/empty clears the override; otherwise clamp to a sane GiB range."""
    if value is None or value == "":
        return None
    try:
        gb = float(value)
    except (TypeError, ValueError):
        return None
    if gb <= 0:
        return None
    return max(_VRAM_GB_LO, min(_VRAM_GB_HI, gb))

DEFAULTS: dict[str, Any] = {
    "progress_expiry_days": 14,
    "continue_watching_days": 7,
    "metadata_sync_interval_hours": 24,
    "channel_catalog_enabled": True,
    "channel_catalog_max_videos": 1000,
    "ui": {},
    "ai": dict(AI_DEFAULTS),
}

CHANNEL_CATALOG_MAX_MIN = 100
CHANNEL_CATALOG_MAX_MAX = 5000
CHANNEL_CATALOG_DESC_LIMIT = 200


def clamp_catalog_max_videos(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = int(DEFAULTS["channel_catalog_max_videos"])
    return max(CHANNEL_CATALOG_MAX_MIN, min(CHANNEL_CATALOG_MAX_MAX, n))


def _path() -> Path:
    from ..config import DATA_DIR
    return DATA_DIR / "app_settings.json"


def _merge_ai(raw: Any) -> dict[str, Any]:
    merged = dict(AI_DEFAULTS)
    if isinstance(raw, dict):
        merged.update({k: v for k, v in raw.items() if k in AI_DEFAULTS})
    merged["category_min_score"] = clamp_category_min_score(
        merged.get("category_min_score")
    )
    merged["summary_length"] = normalize_summary_length(merged.get("summary_length"))
    merged["vram_gb"] = clamp_vram_gb(merged.get("vram_gb"))
    return merged


def load() -> dict[str, Any]:
    p = _path()
    try:
        if p.exists():
            data = json.loads(p.read_text())
            merged = {**DEFAULTS, **data}
            # Deep-merge ui so partial saves don't wipe nested keys on read.
            ui = data.get("ui")
            if isinstance(ui, dict):
                merged["ui"] = ui
            else:
                merged["ui"] = {}
            merged["ai"] = _merge_ai(data.get("ai"))
            return merged
    except Exception:  # noqa: BLE001
        pass
    out = dict(DEFAULTS)
    out["ai"] = dict(AI_DEFAULTS)
    return out


def save(updates: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        current = load()
        if "ui" in updates and isinstance(updates["ui"], dict):
            existing_ui = current.get("ui") if isinstance(current.get("ui"), dict) else {}
            current["ui"] = {**existing_ui, **updates["ui"]}
            updates = {k: v for k, v in updates.items() if k != "ui"}
        if "ai" in updates and isinstance(updates["ai"], dict):
            current["ai"] = _merge_ai({**current.get("ai", {}), **updates["ai"]})
            updates = {k: v for k, v in updates.items() if k != "ai"}
        current.update(updates)
        p = _path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(current, indent=2))
        return current


def ai_settings() -> dict[str, Any]:
    return _merge_ai(load().get("ai"))
