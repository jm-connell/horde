import json
import threading
from pathlib import Path
from typing import Any

_lock = threading.Lock()

DEFAULTS: dict[str, Any] = {
    "progress_expiry_days": 14,
    "continue_watching_days": 7,
    "metadata_sync_interval_hours": 24,
    "ui": {},
}


def _path() -> Path:
    from ..config import DATA_DIR
    return DATA_DIR / "app_settings.json"


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
            return merged
    except Exception:  # noqa: BLE001
        pass
    return dict(DEFAULTS)


def save(updates: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        current = load()
        if "ui" in updates and isinstance(updates["ui"], dict):
            existing_ui = current.get("ui") if isinstance(current.get("ui"), dict) else {}
            current["ui"] = {**existing_ui, **updates["ui"]}
            updates = {k: v for k, v in updates.items() if k != "ui"}
        current.update(updates)
        p = _path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(current, indent=2))
        return current
