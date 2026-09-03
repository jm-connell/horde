"""Persistent cache of channel-feed video metadata (views, dates, etc.)."""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, NamedTuple, Optional

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


def drop(yt_id: str) -> None:
    """Remove a single YouTube id from the feed meta cache."""
    if not yt_id:
        return
    with _lock:
        cache = load()
        if yt_id not in cache:
            return
        cache.pop(yt_id, None)
        save(cache)


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
                "like_count",
                "dislike_count",
            ):
                val = entry.get(key)
                if val is not None:
                    merged[key] = val
            # None clears a stale relative label once a real calendar date is known.
            if "published_label" in entry:
                label = entry.get("published_label")
                if label:
                    merged["published_label"] = label
                else:
                    merged.pop("published_label", None)
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


_RELATIVE_AGO_RE = re.compile(
    r"(?:(?:streamed|premiered|uploaded|aired)\s+)?"
    r"(?:(?:over|about|almost|around)\s+)?"
    r"(?P<n>\d+)\s+"
    r"(?P<unit>seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago",
    re.IGNORECASE,
)
_YESTERDAY_RE = re.compile(r"\byesterday\b", re.IGNORECASE)
_UNIT_SECONDS = {
    "second": 1,
    "seconds": 1,
    "minute": 60,
    "minutes": 60,
    "hour": 3600,
    "hours": 3600,
    "day": 86400,
    "days": 86400,
    "week": 86400 * 7,
    "weeks": 86400 * 7,
    "month": 86400 * 30,
    "months": 86400 * 30,
    "year": 86400 * 365,
    "years": 86400 * 365,
}
_SINGULAR_UNIT = {
    "second": "second",
    "seconds": "second",
    "minute": "minute",
    "minutes": "minute",
    "hour": "hour",
    "hours": "hour",
    "day": "day",
    "days": "day",
    "week": "week",
    "weeks": "week",
    "month": "month",
    "months": "month",
    "year": "year",
    "years": "year",
}
_MONTH_ABBR = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)


def _month_year_label(dt: datetime) -> str:
    return f"{_MONTH_ABBR[dt.month - 1]} {dt.year}"


class PublishedMeta(NamedTuple):
    """Sort ISO plus an honest display label when the calendar day is not known."""

    iso: Optional[str] = None
    label: Optional[str] = None
    precision: Optional[str] = None  # day | month | year | relative


def _from_unix(value: float) -> Optional[str]:
    n = float(value)
    if n > 1e12:
        n /= 1000.0
    if n <= 0:
        return None
    try:
        return datetime.fromtimestamp(n, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _dt_from_iso(iso: str) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _unit_phrase(n: int, singular: str) -> str:
    n = max(1, int(n))
    if n == 1:
        return f"1 {singular} ago"
    return f"{n} {singular}s ago"


def format_relative_ago(
    dt: datetime, *, now: Optional[datetime] = None
) -> str:
    """YouTube-style age string. Does not invent a calendar day."""
    now = now or datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    seconds = max(0.0, (now - dt).total_seconds())
    minutes = seconds / 60
    hours = seconds / 3600
    days = seconds / 86400
    if seconds < 45:
        return "just now"
    if minutes < 60:
        return _unit_phrase(round(minutes), "minute")
    if hours < 24:
        return _unit_phrase(round(hours), "hour")
    if days < 7.5:
        return _unit_phrase(round(days), "day")
    weeks = days / 7
    if weeks < 4.5:
        return _unit_phrase(round(weeks), "week")
    months = days / 30
    if months < 11.5:
        n = max(1, round(months))
        if n >= 12:
            return _unit_phrase(1, "year")
        return _unit_phrase(n, "month")
    return _unit_phrase(round(days / 365), "year")


def relative_label_from_text(raw: str) -> Optional[str]:
    """Keep YouTube's '3 years ago' wording; drop 'Streamed' / similar prefixes."""
    s = raw.strip()
    if not s:
        return None
    if _YESTERDAY_RE.search(s):
        return "1 day ago"
    match = _RELATIVE_AGO_RE.search(s)
    if not match:
        return None
    singular = _SINGULAR_UNIT.get(match.group("unit").lower())
    if not singular:
        return None
    return _unit_phrase(int(match.group("n")), singular)


def parse_upload_date(raw: Any) -> Optional[str]:
    """Normalize yt-dlp dates (YYYYMMDD, unix, ISO, relative 'N years ago') to ISO UTC."""
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, datetime):
        dt = raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    if isinstance(raw, (int, float)):
        return _from_unix(raw)
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
    if s.isdigit():
        return _from_unix(float(s))
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        try:
            if "T" in s or s.endswith("Z") or (len(s) > 10 and "+" in s[10:]):
                iso = s.replace("Z", "+00:00")
                dt = datetime.fromisoformat(iso)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.isoformat()
            return (
                datetime.strptime(s[:10], "%Y-%m-%d")
                .replace(tzinfo=timezone.utc)
                .isoformat()
            )
        except ValueError:
            pass
    if _YESTERDAY_RE.search(s):
        return (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    match = _RELATIVE_AGO_RE.search(s)
    if match:
        unit = match.group("unit").lower()
        secs = _UNIT_SECONDS.get(unit)
        if secs:
            n = int(match.group("n"))
            return (
                datetime.now(timezone.utc) - timedelta(seconds=n * secs)
            ).isoformat()
    return None


def published_meta_from_entry(entry: Optional[dict[str, Any]]) -> PublishedMeta:
    """Precise calendar dates when yt-dlp has them; relative labels otherwise.

    Channel/search tabs often only have 'N years ago'. That is enough to sort
    (via an approximate timestamp) but must not be shown as a made-up day.
    """
    if not entry:
        return PublishedMeta()

    for key in ("upload_date", "release_date"):
        raw = entry.get(key)
        if raw is None or raw == "":
            continue
        s = str(raw).strip()
        if len(s) == 4 and s.isdigit():
            iso = parse_upload_date(f"{s}0101")
            return PublishedMeta(iso=iso, label=s, precision="year")
        if len(s) == 6 and s.isdigit():
            iso = parse_upload_date(f"{s}01")
            if iso:
                dt = _dt_from_iso(iso)
                label = _month_year_label(dt) if dt is not None else s
                return PublishedMeta(iso=iso, label=label, precision="month")
        iso = parse_upload_date(raw)
        if iso:
            return PublishedMeta(iso=iso, precision="day")

    raw_pub = entry.get("published_at")
    if isinstance(raw_pub, str) and raw_pub.strip():
        rel = relative_label_from_text(raw_pub)
        if rel:
            return PublishedMeta(
                iso=parse_upload_date(raw_pub),
                label=rel,
                precision="relative",
            )
        stripped = raw_pub.strip()
        if len(stripped) == 4 and stripped.isdigit():
            iso = parse_upload_date(f"{stripped}0101")
            return PublishedMeta(iso=iso, label=stripped, precision="year")
        iso = parse_upload_date(raw_pub)
        if iso:
            return PublishedMeta(iso=iso, precision="day")

    time_text = None
    raw_time_text = entry.get("publishedTimeText")
    if isinstance(raw_time_text, str) and raw_time_text.strip():
        time_text = relative_label_from_text(raw_time_text)

    # timestamp from youtubetab:approximate_date is now-N units, not a real day.
    for key in ("timestamp", "release_timestamp"):
        raw = entry.get(key)
        if raw is None or raw == "":
            continue
        iso = parse_upload_date(raw)
        if not iso:
            continue
        dt = _dt_from_iso(iso)
        if dt is None:
            continue
        return PublishedMeta(
            iso=iso,
            label=time_text or format_relative_ago(dt),
            precision="relative",
        )
    if time_text:
        return PublishedMeta(
            iso=parse_upload_date(raw_time_text),
            label=time_text,
            precision="relative",
        )
    return PublishedMeta()


def published_at_from_entry(entry: Optional[dict[str, Any]]) -> Optional[str]:
    """Sort key (ISO) from a yt-dlp info/entry dict."""
    return published_meta_from_entry(entry).iso
