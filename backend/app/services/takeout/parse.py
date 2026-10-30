"""Read the YouTube part of a Google Takeout export.

Takeout hands out one or more ``.zip`` files (a big export is split into parts).
Three things in them are read, wherever they sit in the archive (the folder names
are translated into the account's language):

* watch history: ``watch-history.json``, or ``watch-history.html`` when the
  export kept Takeout's default format (read on a best-effort basis: its dates
  are written for people, in the account's language and time zone);
* subscriptions: the CSV with a channel id, URL and title per row;
* playlists: one CSV of video ids per playlist, plus the index CSV that names
  them (and the older layout: one CSV per playlist with the name on top).

The CSVs are recognised by their header rows, not their names. Everything else
in the archive (comments, uploads, search history) is skipped without being
decompressed. A loose ``.json`` / ``.html`` / ``.csv`` from an unzipped export
is read the same way.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import re
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import PurePosixPath
from typing import IO, Any

from ..follows import normalize_channel_url
from ..url_clean import youtube_video_id

logger = logging.getLogger(__name__)

#: Largest watch history file read (JSON; a decade of heavy viewing is ~100 MB).
#: Parsing takes several times this in memory, so it stays well below RAM sizes.
MAX_HISTORY_BYTES = 160 * 1024 * 1024
#: Largest CSV read (subscriptions, one playlist): far above any real one.
MAX_CSV_BYTES = 16 * 1024 * 1024
#: Everything read from one import together.
MAX_TOTAL_BYTES = 320 * 1024 * 1024
#: A member that unpacks to more than this many times its packed size is not a
#: Takeout file (text compresses about 10x) but a decompression bomb.
MAX_COMPRESSION_RATIO = 100
_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
#: Prefixes Takeout puts before a title in English exports ("Watched <title>").
_TITLE_PREFIXES = ("Watched ", "Watched\xa0")


class TakeoutError(ValueError):
    """The upload is not something Horde can read as a Takeout export."""


@dataclass(frozen=True)
class WatchView:
    yt_id: str
    watched_at: datetime
    title: str | None = None
    channel: str | None = None
    #: Normalized (``follows.normalize_channel_url``).
    channel_url: str | None = None


@dataclass(frozen=True)
class Subscription:
    channel_url: str
    channel_name: str | None


@dataclass
class TakeoutPlaylist:
    title: str
    #: YouTube's playlist id, when the export names it.
    playlist_id: str | None = None
    visibility: str | None = None
    #: Video ids in the export's order, without repeats.
    video_ids: list[str] = field(default_factory=list)


@dataclass
class TakeoutData:
    views: list[WatchView] = field(default_factory=list)
    subscriptions: list[Subscription] = field(default_factory=list)
    playlists: list[TakeoutPlaylist] = field(default_factory=list)
    #: Whether a watch history file was found at all (it can be empty).
    found_history: bool = False
    #: Views of videos whose time could not be read (an HTML date in a format
    #: or time zone Horde does not know). Removed videos and ads are not counted.
    skipped_views: int = 0


# --- entry point --------------------------------------------------------------


def read_export(files: list[tuple[str, IO[bytes]]]) -> TakeoutData:
    """Everything Horde reads from ``(file name, binary file)`` pairs."""
    reader = _Reader()
    try:
        for name, handle in files:
            lower = name.lower()
            if lower.endswith(".zip") or zipfile.is_zipfile(handle):
                handle.seek(0)
                reader.read_zip(name, handle)
            elif _wanted(name):
                handle.seek(0)
                limit = reader.member_limit(name)
                data = handle.read(limit + 1)
                if len(data) > limit:
                    raise TakeoutError(f"{name} is too large to read")
                reader.read_member(name, data)
    except (csv.Error, RecursionError, UnicodeDecodeError) as exc:
        # Malformed or hostile files: oversized CSV fields, absurd nesting.
        raise TakeoutError("Part of this export could not be read") from exc
    return reader.finish()


class _Reader:
    def __init__(self) -> None:
        self.data = TakeoutData()
        self.subscriptions: dict[str, Subscription] = {}
        #: Index rows (new layout) by title, and per-playlist video files by name.
        self.index: list[TakeoutPlaylist] = []
        self.video_files: list[tuple[str, list[str]]] = []
        self.old_layout: list[TakeoutPlaylist] = []
        self.read_bytes = 0

    def member_limit(self, path: str) -> int:
        """How much of this file may still be read (the per-kind and total caps)."""
        lower = PurePosixPath(path.replace("\\", "/")).name.lower()
        kind = MAX_CSV_BYTES if lower.endswith(".csv") else MAX_HISTORY_BYTES
        return max(0, min(kind, MAX_TOTAL_BYTES - self.read_bytes))

    def read_zip(self, name: str, handle: IO[bytes]) -> None:
        try:
            archive = zipfile.ZipFile(handle)
        except zipfile.BadZipFile as exc:
            raise TakeoutError(f"{name} is not a readable .zip file") from exc
        with archive:
            for info in archive.infolist():
                if info.is_dir() or not _wanted(info.filename):
                    continue
                if info.file_size > self.member_limit(info.filename):
                    raise TakeoutError(f"{info.filename} is too large to read")
                if info.file_size > MAX_COMPRESSION_RATIO * max(
                    info.compress_size, 1024
                ):
                    raise TakeoutError(f"{info.filename} is not a Takeout file")
                try:
                    raw = archive.read(info)
                except (zipfile.BadZipFile, OSError, EOFError) as exc:
                    raise TakeoutError(
                        f"Could not read {info.filename} from {name}"
                    ) from exc
                self.read_member(info.filename, raw)

    def read_member(self, path: str, raw: bytes) -> None:
        self.read_bytes += len(raw)
        base = PurePosixPath(path.replace("\\", "/")).name
        lower = base.lower()
        if lower in ("watch-history.json", "watch-history.html"):
            self.data.found_history = True
            views, skipped = (
                _history_json(raw, path)
                if lower.endswith(".json")
                else _history_html(raw)
            )
            self.data.views.extend(views)
            self.data.skipped_views += skipped
        elif lower.endswith(".csv"):
            self._csv(base, raw)

    def _csv(self, base: str, raw: bytes) -> None:
        text = raw.decode("utf-8-sig", errors="replace")
        rows = [row for row in csv.reader(io.StringIO(text))]
        if not rows:
            return
        header = [cell.strip().lower() for cell in rows[0]]
        if _is_subscriptions(header):
            self._subscriptions(header, rows[1:])
        elif _is_video_list(header):
            self.video_files.append((base, _video_ids(rows[1:])))
        elif header and header[0] == "playlist id":
            self._playlist_header(base, header, rows)

    def _subscriptions(self, header: list[str], rows: list[list[str]]) -> None:
        url_col = header.index("channel url")
        title_col = _column(header, "channel title")
        for row in rows:
            if len(row) <= url_col:
                continue
            url = normalize_channel_url(row[url_col])
            if not url or url in self.subscriptions:
                continue
            name = row[title_col].strip() if title_col is not None else ""
            self.subscriptions[url] = Subscription(url, name or None)

    def _playlist_header(
        self, base: str, header: list[str], rows: list[list[str]]
    ) -> None:
        title_col = _column(header, "title")
        vis_col = _column(header, "visibility")
        # Older layout: one playlist's details, a blank row, then its videos.
        split = next(
            (
                i
                for i, row in enumerate(rows)
                if row and row[0].strip().lower() == "video id"
            ),
            None,
        )
        details = rows[1:split] if split is not None else rows[1:]
        playlists = []
        for row in details:
            if not row or not row[0].strip():
                continue
            title = _cell(row, title_col) or PurePosixPath(base).stem
            playlists.append(
                TakeoutPlaylist(
                    title=title,
                    playlist_id=row[0].strip() or None,
                    visibility=_cell(row, vis_col),
                )
            )
        if split is not None:
            if playlists:
                playlists[0].video_ids = _video_ids(rows[split + 1 :])
                self.old_layout.append(playlists[0])
            return
        self.index.extend(playlists)

    def finish(self) -> TakeoutData:
        by_title = {p.title.casefold(): p for p in self.index}
        found: list[TakeoutPlaylist] = list(self.old_layout)
        for base, ids in self.video_files:
            stem = PurePosixPath(base).stem
            title = re.sub(r"-videos$", "", stem, flags=re.IGNORECASE)
            playlist = by_title.pop(title.casefold(), None) or TakeoutPlaylist(title)
            playlist.video_ids = ids
            found.append(playlist)
        # Index rows without a video file are playlists with nothing in them.
        self.data.playlists = sorted(
            (p for p in found if p.video_ids), key=lambda p: p.title.casefold()
        )
        self.data.subscriptions = sorted(
            self.subscriptions.values(),
            key=lambda s: (s.channel_name or s.channel_url).casefold(),
        )
        return self.data


def _wanted(path: str) -> bool:
    lower = PurePosixPath(path.replace("\\", "/")).name.lower()
    return lower in ("watch-history.json", "watch-history.html") or lower.endswith(
        ".csv"
    )


def _column(header: list[str], word: str) -> int | None:
    return next((i for i, name in enumerate(header) if word in name), None)


def _cell(row: list[str], index: int | None) -> str | None:
    if index is None or index >= len(row):
        return None
    return row[index].strip() or None


def _is_subscriptions(header: list[str]) -> bool:
    return "channel id" in header and "channel url" in header and len(header) <= 4


def _is_video_list(header: list[str]) -> bool:
    # A playlist's videos: the id and when it was added. Other exports with a
    # video id column (comments, video metadata) carry many more columns.
    return bool(header) and header[0] == "video id" and len(header) <= 3


def _video_ids(rows: list[list[str]]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for row in rows:
        if not row:
            continue
        vid = row[0].strip()
        if _YT_ID_RE.match(vid) and vid not in seen:
            seen.add(vid)
            out.append(vid)
    return out


# --- watch history --------------------------------------------------------------


def _clean_title(title: str | None, url: str | None) -> str | None:
    text = (title or "").strip()
    for prefix in _TITLE_PREFIXES:
        if text.startswith(prefix):
            text = text[len(prefix) :].strip()
            break
    # A video whose title YouTube no longer knows is listed by its link.
    if not text or (url and text == url) or text.startswith("https://"):
        return None
    return text


def _history_json(raw: bytes, path: str) -> tuple[list[WatchView], int]:
    """The views in ``watch-history.json``, and how many had no readable time."""
    try:
        items = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise TakeoutError(f"{path} is not valid JSON") from exc
    if not isinstance(items, list):
        raise TakeoutError(f"{path} is not a YouTube watch history")
    views: list[WatchView] = []
    skipped = 0
    for item in items:
        view = _json_view(item)
        if isinstance(view, WatchView):
            views.append(view)
        elif view == _NO_TIME:
            skipped += 1
    return views, skipped


#: ``_json_view``'s answer for a video view whose time cannot be read.
_NO_TIME = "no time"


def _json_view(item: Any) -> WatchView | str | None:
    """The view, ``_NO_TIME``, or None for what is not a video view at all."""
    if not isinstance(item, dict):
        return None
    # YouTube Music plays and ads are in the same file; neither is a video watched.
    if item.get("header") not in (None, "YouTube"):
        return None
    if any(
        isinstance(d, dict) and d.get("name") == "From Google Ads"
        for d in item.get("details") or []
    ):
        return None
    url = item.get("titleUrl")
    yt_id = youtube_video_id(url) if isinstance(url, str) else None
    if not yt_id:
        return None  # a removed video: no link
    stamp = _parse_iso(item.get("time"))
    if stamp is None:
        return _NO_TIME
    channel = channel_url = None
    subtitles = item.get("subtitles")
    if isinstance(subtitles, list) and subtitles and isinstance(subtitles[0], dict):
        channel = (str(subtitles[0].get("name") or "")).strip() or None
        channel_url = normalize_channel_url(str(subtitles[0].get("url") or "")) or None
    title = item.get("title")
    return WatchView(
        yt_id=yt_id,
        watched_at=stamp,
        title=_clean_title(title if isinstance(title, str) else None, url),
        channel=channel,
        channel_url=channel_url,
    )


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=UTC)
    return stamp.astimezone(UTC)


#: Time zone abbreviations an English export ends its dates with.
_ZONES = {
    "UTC": 0,
    "GMT": 0,
    "WET": 0,
    "BST": 1,
    "IST": 5.5,  # India; Takeout's English exports use it for India Standard Time
    "CET": 1,
    "WEST": 1,
    "CEST": 2,
    "EET": 2,
    "EEST": 3,
    "MSK": 3,
    "AST": -4,
    "ADT": -3,
    "EST": -5,
    "EDT": -4,
    "CST": -6,
    "CDT": -5,
    "MST": -7,
    "MDT": -6,
    "PST": -8,
    "PDT": -7,
    "AKST": -9,
    "AKDT": -8,
    "HST": -10,
    "JST": 9,
    "KST": 9,
    "AEST": 10,
    "AEDT": 11,
    "ACST": 9.5,
    "ACDT": 10.5,
    "AWST": 8,
    "NZST": 12,
    "NZDT": 13,
}
_HTML_FORMATS = (
    "%b %d, %Y, %I:%M:%S %p",  # Mar 1, 2024, 12:34:56 PM
    "%d %b %Y, %H:%M:%S",  # 1 Mar 2024, 12:34:56
    "%b %d, %Y, %H:%M:%S",
)


def _parse_html_date(text: str) -> datetime | None:
    clean = re.sub(r"[ \xa0\s]+", " ", text).strip()
    zone: timezone = UTC
    match = re.match(r"^(.*?)\s+([A-Z]{2,5}|(?:UTC|GMT)[+-]\d{1,2}(?::\d\d)?)$", clean)
    if match:
        clean, abbr = match.group(1), match.group(2)
        offset_match = re.match(r"^(?:UTC|GMT)([+-])(\d{1,2})(?::(\d\d))?$", abbr)
        if offset_match:
            sign = 1 if offset_match.group(1) == "+" else -1
            minutes = int(offset_match.group(2)) * 60 + int(offset_match.group(3) or 0)
            zone = timezone(sign * timedelta(minutes=minutes))
        elif abbr in _ZONES:
            zone = timezone(timedelta(hours=_ZONES[abbr]))
        else:
            return None  # a zone we cannot place: better skipped than hours off
    for fmt in _HTML_FORMATS:
        try:
            return datetime.strptime(clean, fmt).replace(tzinfo=zone).astimezone(UTC)
        except ValueError:
            continue
    return None


class _HistoryHtml(HTMLParser):
    """Each ``outer-cell`` block of ``watch-history.html`` is one entry."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.views: list[WatchView] = []
        self.skipped = 0
        self._divs: list[bool] = []  # per open div: is it an outer cell?
        self._entry: dict[str, Any] | None = None
        self._href: str | None = None
        self._link_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "div":
            classes = (dict(attrs).get("class") or "").split()
            outer = "outer-cell" in classes
            self._divs.append(outer)
            if outer:
                self._entry = {"links": [], "texts": []}
        elif tag == "a" and self._entry is not None:
            self._href = dict(attrs).get("href") or ""
            self._link_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._entry is not None and self._href is not None:
            self._entry["links"].append((self._href, "".join(self._link_text).strip()))
            self._href = None
        elif tag == "div" and self._divs:
            if self._divs.pop() and self._entry is not None:
                self._finish(self._entry)
                self._entry = None

    def handle_data(self, data: str) -> None:
        if self._entry is None:
            return
        if self._href is not None:
            self._link_text.append(data)
        elif data.strip():
            self._entry["texts"].append(data.strip())

    def _finish(self, entry: dict[str, Any]) -> None:
        texts: list[str] = entry["texts"]
        # The header cell says the product; ads say so in their details.
        if texts and texts[0] != "YouTube":
            return
        if any("From Google Ads" in t for t in texts):
            return
        links: list[tuple[str, str]] = entry["links"]
        video = next(
            ((h, t) for h, t in links if youtube_video_id(h)),
            None,
        )
        if video is None:
            return
        stamp = next(
            (d for d in (_parse_html_date(t) for t in reversed(texts)) if d), None
        )
        if stamp is None:
            self.skipped += 1
            return
        channel = next(
            ((h, t) for h, t in links if "/channel/" in h or "/@" in h), None
        )
        self.views.append(
            WatchView(
                yt_id=str(youtube_video_id(video[0])),
                watched_at=stamp,
                title=_clean_title(video[1], video[0]),
                channel=(channel[1] or None) if channel else None,
                channel_url=(normalize_channel_url(channel[0]) or None)
                if channel
                else None,
            )
        )


def _history_html(raw: bytes) -> tuple[list[WatchView], int]:
    """The views in ``watch-history.html``, and how many had no readable time."""
    parser = _HistoryHtml()
    parser.feed(raw.decode("utf-8", errors="replace"))
    parser.close()
    return parser.views, parser.skipped
