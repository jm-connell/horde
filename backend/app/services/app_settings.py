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
    "ai_duplicates": True,
    "paused": False,
}

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
