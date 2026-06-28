import json
import threading
from pathlib import Path
from typing import Any

_lock = threading.Lock()

DEFAULTS: dict[str, Any] = {
    "progress_expiry_days": 14,
    "metadata_sync_interval_hours": 24,
}


def _path() -> Path:
    from ..config import DATA_DIR
    return DATA_DIR / "app_settings.json"


def load() -> dict[str, Any]:
    p = _path()
    try:
        if p.exists():
            data = json.loads(p.read_text())
            return {**DEFAULTS, **data}
    except Exception:  # noqa: BLE001
        pass
    return dict(DEFAULTS)


def save(updates: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        current = load()
        current.update(updates)
        p = _path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(current, indent=2))
        return current
