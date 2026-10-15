"""Helpers for the yt-dlp ``info`` dicts a download carries around."""

from datetime import UTC, datetime
from typing import Any


def as_info(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def merge_info(base: dict[str, Any], extra: Any) -> dict[str, Any]:
    if not isinstance(extra, dict) or not extra:
        return base
    return {**base, **extra}


def collect_tags(info: dict[str, Any]) -> list[str]:
    info = as_info(info)
    collected: list[str] = []
    seen: set[str] = set()
    for key in ("tags", "categories"):
        for item in info.get(key) or []:
            tag = str(item).strip()
            low = tag.lower()
            if tag and low not in seen:
                seen.add(low)
                collected.append(tag)
    return collected


def published_at(info: dict[str, Any]) -> datetime | None:
    raw = info.get("upload_date")
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y%m%d").replace(tzinfo=UTC)
    except ValueError:
        return None
