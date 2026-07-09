"""Persistent cache of channel-feed video metadata (views, dates, etc.)."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

_lock = threading.Lock()


def _path() -> Path:
    from ..config import DATA_DIR

    return DATA_DIR / "feed_meta_cache.json"


def load() -> dict[str, dict[str, Any]]:
    p = _path()
    try:
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {k: v for k, v in data.items() if isinstance(v, dict)}
    except Exception:  # noqa: BLE001
        pass
    return {}


def save(cache: dict[str, dict[str, Any]]) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cache, indent=0, default=str), encoding="utf-8")


def get_many(ids: list[str]) -> dict[str, dict[str, Any]]:
    if not ids:
        return {}
    with _lock:
        cache = load()
        return {i: cache[i] for i in ids if i in cache}


def upsert_many(entries: list[dict[str, Any]]) -> None:
    """Merge entry dicts keyed by YouTube id into the cache."""
    if not entries:
        return
    with _lock:
        cache = load()
        now = datetime.now(timezone.utc).isoformat()
        for entry in entries:
            yt_id = entry.get("id")
            if not yt_id or not isinstance(yt_id, str):
                continue
            prev = cache.get(yt_id, {})
            merged = {**prev}
            for key in (
                "view_count",
                "published_at",
                "duration",
                "thumbnail_url",
                "title",
                "max_height",
            ):
                val = entry.get(key)
                if val is not None:
                    merged[key] = val
            merged["updated_at"] = now
            cache[yt_id] = merged
        # Cap size to avoid unbounded growth
        if len(cache) > 5000:
            items = sorted(
                cache.items(),
                key=lambda kv: str(kv[1].get("updated_at") or ""),
                reverse=True,
            )
            cache = dict(items[:4000])
        save(cache)


def parse_upload_date(raw: Any) -> Optional[str]:
    """Normalize yt-dlp upload_date (YYYYMMDD) or timestamp to ISO UTC string."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        try:
            return datetime.fromtimestamp(float(raw), tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    s = str(raw).strip()
    if not s:
        return None
    if len(s) == 8 and s.isdigit():
        try:
            return (
                datetime.strptime(s, "%Y%m%d")
                .replace(tzinfo=timezone.utc)
                .isoformat()
            )
        except ValueError:
            return None
    return s
