"""Chapter lists from descriptions, yt-dlp metadata, and timed captions."""

from __future__ import annotations

import json
import math
import re
from typing import Any, Literal, Optional

from ..config import DOWNLOADS_DIR
from ..models import Video, VideoAiMeta
from . import library

ChapterSource = Literal["description", "source", "ai"]
Chapter = dict[str, Any]

# Match frontend parseChapters in utils.ts.
_CHAPTER_LINE_RE = re.compile(
    r"^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\s*[-–—|·•:→]?\s*)(.+)"
)
_PAREN_TITLE_RE = re.compile(r"^\((.+)\)$")

_CUE_TS_RE = re.compile(
    r"^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$"
)
_CUE_TIMING_RE = re.compile(
    r"^((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,3})?)\s*-->\s*"
    r"((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,3})?)"
)
_NAMED_VTT_ENTITIES = {
    "nbsp": " ",
    "amp": "&",
    "lt": "<",
    "gt": ">",
    "quot": '"',
    "apos": "'",
    "lrm": "",
    "rlm": "",
}
_VTT_ENTITY_RE = re.compile(r"&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);?")

MIN_CHAPTER_DURATION_SEC = 180.0
MIN_SEGMENT_SEC = 12.0
MIN_SEGMENT_SHORT_SEC = 8.0
SHORT_VIDEO_SEC = 360.0
FIRST_SNAP_TO_ZERO_SEC = 20.0
CUE_WINDOW_SEC = 12.0
TOPIC_LOOKBACK_SEC = 75.0
TOPIC_NEIGHBOR_SEC = 10.0
SNAP_EARLIER_TIE_SEC = 3.0
MUSIC_UNIQUE_RATIO = 0.35
MUSIC_MIN_LINES = 10
MAX_CHAPTERS_HARD = 40

_TRANSCRIPT_CHARS = {
    "light": 16_000,
    "normal": 32_000,
    "heavy": 48_000,
}

CHAPTERS_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "chapters": {
            "type": "array",
            "minItems": 2,
            "items": {
                "type": "object",
                "properties": {
                    "start_sec": {"type": "number"},
                    "title": {"type": "string"},
                },
                "required": ["start_sec", "title"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["chapters"],
    "additionalProperties": False,
}


def parse_chapters(description: Optional[str]) -> list[Chapter]:
    """YouTube-style timestamp lines; empty unless ≥2 strictly ascending."""
    if not description:
        return []
    chapters: list[Chapter] = []
    for raw_line in description.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        match = _CHAPTER_LINE_RE.match(line)
        if not match:
            continue
        hour, minute, sec, rest = match.groups()
        secs = (int(hour) * 3600 if hour else 0) + int(minute) * 60 + int(sec)
        title = rest.strip()
        wrapped = _PAREN_TITLE_RE.match(title)
        if wrapped:
            title = wrapped.group(1)
        if title:
            chapters.append({"start_sec": float(secs), "title": title})
    return _require_ascending(chapters)


def parse_chapter_list(raw: Any) -> list[Chapter]:
    """Parse stored JSON (or a list) into a valid chapter list."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
    if not isinstance(raw, list):
        return []
    out: list[Chapter] = []
    for item in raw:
        chapter = _coerce_chapter(item)
        if chapter is not None:
            out.append(chapter)
    return _require_ascending(out)


def dump_chapter_list(chapters: list[Chapter]) -> str:
    cleaned = parse_chapter_list(chapters)
    return json.dumps(
        [{"start_sec": c["start_sec"], "title": c["title"]} for c in cleaned]
    )


def normalize_ytdlp_chapters(raw: Any) -> list[Chapter]:
    """yt-dlp `chapters` (`start_time` / `title`) → stored chapter dicts."""
    if not isinstance(raw, list):
        return []
    out: list[Chapter] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        start = item.get("start_time", item.get("start_sec"))
        title = str(item.get("title") or "").strip()
        try:
            start_sec = float(start)
        except (TypeError, ValueError):
            continue
        if start_sec < 0 or not title:
            continue
        out.append({"start_sec": start_sec, "title": title})
    out.sort(key=lambda c: c["start_sec"])
    deduped: list[Chapter] = []
    for chapter in out:
        if deduped and chapter["start_sec"] <= deduped[-1]["start_sec"]:
            continue
        deduped.append(chapter)
    if len(deduped) < 2:
        return []
    return deduped


def apply_source_chapters(
    video: Video, info: dict[str, Any], *, replace_empty: bool = True
) -> None:
    chapters = normalize_ytdlp_chapters(info.get("chapters"))
    if chapters or replace_empty:
        video.source_chapters = dump_chapter_list(chapters)


def source_chapters_for(video: Video) -> list[Chapter]:
    return parse_chapter_list(getattr(video, "source_chapters", None) or "[]")


def ai_chapters_for(meta: Optional[VideoAiMeta]) -> list[Chapter]:
    if meta is None:
        return []
    return parse_chapter_list(getattr(meta, "chapters", None))


def resolve_chapters(
    video: Video, meta: Optional[VideoAiMeta] = None
) -> tuple[list[Chapter], Optional[ChapterSource]]:
    from_desc = parse_chapters(video.description)
    if from_desc:
        return from_desc, "description"
    from_source = source_chapters_for(video)
    if from_source:
        return from_source, "source"
    from_ai = ai_chapters_for(meta)
    if from_ai:
        return from_ai, "ai"
    return [], None


def transcript_char_cap(profile: Any = None) -> int:
    key = str(profile or "normal").strip().lower()
    return int(_TRANSCRIPT_CHARS.get(key, _TRANSCRIPT_CHARS["normal"]))


def parse_vtt_cues(raw: str) -> list[tuple[float, str]]:
    """Return (start_sec, text) cues, collapsing consecutive duplicate text."""
    cues: list[tuple[float, str]] = []
    pending_start: Optional[float] = None
    pending_lines: list[str] = []

    def flush() -> None:
        nonlocal pending_start, pending_lines
        if pending_start is None:
            pending_lines = []
            return
        text = " ".join(pending_lines).strip()
        pending_lines = []
        start = pending_start
        pending_start = None
        if not text:
            return
        if cues and cues[-1][1] == text:
            return
        cues.append((start, text))

    for line in (raw or "").splitlines():
        s = line.strip()
        if not s:
            flush()
            continue
        if s.upper().startswith("WEBVTT"):
            continue
        if s.isdigit():
            continue
        if s.startswith("NOTE") or s.startswith("STYLE") or s.startswith("REGION"):
            continue
        timing = _CUE_TIMING_RE.match(s)
        if timing:
            flush()
            pending_start = _parse_cue_ts(timing.group(1))
            continue
        if pending_start is None:
            continue
        cleaned = _clean_cue_text(s)
        if cleaned:
            pending_lines.append(cleaned)
    flush()
    return cues


def load_timed_cues(video: Video) -> list[tuple[float, str]]:
    tracks = library.parse_subtitles(video.subtitles)
    if not tracks:
        return []

    def rank(track: dict) -> tuple[int, int]:
        lang = str(track.get("lang") or "").lower()
        auto = 1 if track.get("auto") else 0
        en = 0 if lang.startswith("en") else 1
        return (auto, en)

    for track in sorted(tracks, key=rank):
        rel = track.get("path")
        if not rel:
            continue
        path = DOWNLOADS_DIR / str(rel)
        if not path.is_file():
            continue
        try:
            cues = parse_vtt_cues(path.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
        if cues:
            return cues
    return []


def format_timed_transcript(
    cues: list[tuple[float, str]], *, max_chars: int
) -> str:
    windows = _downsample_cues(cues, CUE_WINDOW_SEC)
    if not windows:
        return ""
    compressed = _fit_transcript_windows(windows, max_chars)
    if compressed:
        return compressed
    lines = []
    for start, text in windows:
        word = text.split()[:1]
        body = word[0] if word else ""
        lines.append(f"[{_fmt_ts(start)}] {body}".rstrip())
    n = len(lines)
    lo, hi = 2, n
    best = _truncate_transcript("\n".join([lines[0], lines[-1]]), max_chars)
    while lo <= hi:
        mid = (lo + hi) // 2
        idxs = _even_indices(n, mid)
        text = "\n".join(lines[i] for i in idxs)
        if len(text) <= max_chars:
            best = text
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def is_music_like(cues: list[tuple[float, str]]) -> bool:
    lines = [text for _, text in cues if text]
    if len(lines) < MUSIC_MIN_LINES:
        return False
    unique = len(set(lines))
    return (unique / len(lines)) < MUSIC_UNIQUE_RATIO


def skip_reason(
    video: Video,
    meta: Optional[VideoAiMeta] = None,
    *,
    force: bool = False,
    cues: Optional[list[tuple[float, str]]] = None,
) -> Optional[str]:
    """Return a short skip token, or None if an LLM chapter job should run."""
    if parse_chapters(video.description):
        return "description_chapters"
    if source_chapters_for(video):
        return "source_chapters"
    has_ai = bool(ai_chapters_for(meta))
    if has_ai and not force:
        return "already_generated"
    skip = (getattr(meta, "chapters_skip_reason", None) or "").strip()
    # Re-check duration when a prior too_short skip was stored (threshold can change).
    if skip and skip != "too_short" and not force:
        return "previously_skipped"
    if not force:
        duration = video.duration_sec
        if duration is not None and float(duration) < MIN_CHAPTER_DURATION_SEC:
            return "too_short"
    loaded = cues
    if loaded is None:
        loaded = load_timed_cues(video)
    if not loaded:
        return "no_subtitles"
    if not force and is_music_like(loaded):
        return "music_like"
    return None


def persist_skip_reason(reason: Optional[str]) -> bool:
    """Whether this skip should stick on video_ai_meta (avoid retry loops)."""
    return reason == "music_like"


def min_segment_sec(duration_sec: Optional[float]) -> float:
    if duration_sec is not None and 0 < float(duration_sec) < SHORT_VIDEO_SEC:
        return MIN_SEGMENT_SHORT_SEC
    return MIN_SEGMENT_SEC


def max_chapter_count(duration_sec: Optional[float]) -> int:
    if duration_sec is None or duration_sec <= 0:
        return 12
    return max(2, min(MAX_CHAPTERS_HARD, int(math.ceil(float(duration_sec) / 120.0))))


def snap_and_validate(
    raw_chapters: list[Any],
    cues: list[tuple[float, str]],
    duration_sec: Optional[float],
) -> list[Chapter]:
    cue_starts = [t for t, _ in cues]
    min_seg = min_segment_sec(duration_sec)
    snapped: list[Chapter] = []
    for item in raw_chapters:
        chapter = _coerce_chapter(item)
        if chapter is None:
            continue
        start = _snap_to_cues(float(chapter["start_sec"]), cue_starts)
        snapped.append({"start_sec": start, "title": chapter["title"]})
    if not snapped:
        return []
    snapped.sort(key=lambda c: c["start_sec"])
    if snapped[0]["start_sec"] <= FIRST_SNAP_TO_ZERO_SEC:
        snapped[0]["start_sec"] = 0.0
    else:
        snapped.insert(0, {"start_sec": 0.0, "title": "Intro"})
    deduped: list[Chapter] = []
    for chapter in snapped:
        if deduped and chapter["start_sec"] <= deduped[-1]["start_sec"]:
            continue
        deduped.append(chapter)
    duration = float(duration_sec) if duration_sec and duration_sec > 0 else None
    if duration is not None:
        deduped = [c for c in deduped if c["start_sec"] < duration]
    nudged: list[Chapter] = []
    prev_start: Optional[float] = None
    for chapter in deduped:
        start = float(chapter["start_sec"])
        if start <= 0.05:
            nudged.append({"start_sec": 0.0, "title": chapter["title"]})
            prev_start = 0.0
            continue
        onset = _topic_onset(
            start,
            str(chapter["title"]),
            cues,
            prev_start=prev_start,
        )
        if prev_start is not None and onset <= prev_start:
            onset = start
        nudged.append({"start_sec": onset, "title": chapter["title"]})
        prev_start = onset
    deduped = []
    for chapter in nudged:
        if deduped and chapter["start_sec"] <= deduped[-1]["start_sec"]:
            continue
        deduped.append(chapter)
    filtered: list[Chapter] = []
    for i, chapter in enumerate(deduped):
        next_start = (
            deduped[i + 1]["start_sec"]
            if i + 1 < len(deduped)
            else (
                duration
                if duration is not None
                else chapter["start_sec"] + min_seg + 1
            )
        )
        if next_start - chapter["start_sec"] < min_seg:
            continue
        filtered.append(chapter)
    if len(filtered) < 2 and len(deduped) >= 2:
        first, last = deduped[0], deduped[-1]
        if last["start_sec"] - first["start_sec"] >= min_seg:
            filtered = [first, last]
    if len(filtered) < 2:
        filtered = _ensure_two_chapters(filtered or deduped, cue_starts, duration, min_seg)
    cap = max_chapter_count(duration)
    if len(filtered) > cap:
        idxs = _even_indices(len(filtered), cap)
        filtered = [filtered[i] for i in idxs]
        filtered = _require_ascending(filtered)
    if len(filtered) < 2:
        return []
    return filtered


def fallback_chapters_from_cues(
    cues: list[tuple[float, str]],
    duration_sec: Optional[float],
) -> list[Chapter]:
    """Last-resort markers from timed captions when the model output is unusable."""
    windows = _downsample_cues(cues, CUE_WINDOW_SEC)
    if len(windows) < 2:
        return []
    cap = max_chapter_count(duration_sec)
    n = min(len(windows), cap)
    idxs = _even_indices(len(windows), n)
    raw: list[Chapter] = []
    for i, idx in enumerate(idxs):
        start, text = windows[idx]
        title = "Intro" if i == 0 else _title_from_cue(text)
        raw.append({"start_sec": start, "title": title})
    return snap_and_validate(raw, cues, duration_sec)


def chapters_from_model_output(raw: str) -> list[Any]:
    """Parse chapter dicts from model JSON, arrays, or fenced blobs."""
    text = (raw or "").strip()
    if not text:
        return []
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    data: Any = None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", text)
        if match:
            try:
                data = json.loads(match.group(1))
            except json.JSONDecodeError:
                data = None
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        for key in ("chapters", "Chapters", "markers", "timestamps", "sections"):
            items = data.get(key)
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]
        if _coerce_chapter(data) is not None:
            return [data]
    return []


def chapters_system_prompt() -> str:
    return (
        "You write video chapter markers for a personal library. "
        "Reply with JSON only: "
        '{"chapters":[{"start_sec":0,"title":"..."}, ...]}. '
        "start_sec is seconds from the start (a number, not a clock string). "
        "Use only timestamps that appear in the transcript. "
        "Put each chapter at the first line where that topic begins, "
        "not after it is already underway. If two nearby times fit, pick the earlier. "
        "Always include a chapter at 0 and at least one later chapter. "
        "Titles are 2–8 words. "
        "Do not invent times that are not in the transcript."
    )


def chapters_prompt(
    video: Video,
    transcript: str,
    *,
    duration_sec: Optional[float],
) -> str:
    duration_label = (
        _fmt_ts(float(duration_sec)) if duration_sec and duration_sec > 0 else "unknown"
    )
    cap = max_chapter_count(duration_sec)
    title = (video.title or "").strip() or "Untitled"
    channel = (video.channel or "").strip()
    return (
        f"Title: {title}\n"
        f"Channel: {channel}\n"
        f"Duration: {duration_label}\n"
        f"Return between 2 and {cap} chapters. Short videos still need at least 2.\n"
        "Pick the earliest transcript timestamp where each new section starts.\n"
        "Do not wait until the topic is fully underway.\n"
        "Use numeric start_sec values in seconds (example: 0, 95, 180).\n\n"
        "Timed transcript:\n"
        f"{transcript}"
    )


def _coerce_chapter(item: Any) -> Optional[Chapter]:
    if not isinstance(item, dict):
        return None
    start = None
    for key in (
        "start_sec",
        "startSec",
        "start_time",
        "startTime",
        "start",
        "time",
        "timestamp",
        "offset",
    ):
        if key in item and item.get(key) is not None:
            start = item.get(key)
            break
    title = str(
        item.get("title") or item.get("name") or item.get("label") or ""
    ).strip()
    start_sec = _parse_start_value(start)
    if start_sec is None or not title:
        return None
    title = re.sub(r"\s+", " ", title).strip()
    if not title or len(title) > 120:
        return None
    return {"start_sec": start_sec, "title": title}


def _parse_start_value(raw: Any) -> Optional[float]:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        val = float(raw)
        if math.isfinite(val) and val >= 0:
            return val
        return None
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None
    try:
        val = float(text)
        if math.isfinite(val) and val >= 0:
            return val
    except ValueError:
        pass
    clock = _CUE_TS_RE.match(text)
    if clock:
        return _parse_cue_ts(text)
    embedded = re.search(
        r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?", text
    )
    if embedded:
        return _parse_cue_ts(embedded.group(0))
    return None


def _ensure_two_chapters(
    chapters: list[Chapter],
    cue_starts: list[float],
    duration: Optional[float],
    min_seg: float,
) -> list[Chapter]:
    if len(chapters) >= 2:
        return chapters
    if not cue_starts:
        return []
    first = (
        dict(chapters[0])
        if chapters
        else {"start_sec": 0.0, "title": "Intro"}
    )
    first["start_sec"] = 0.0
    if not first.get("title"):
        first["title"] = "Intro"
    end = duration if duration is not None else cue_starts[-1] + min_seg + 1
    later = [t for t in cue_starts if t >= min_seg and t < end]
    if not later:
        return []
    return [first, {"start_sec": later[-1], "title": "Rest of video"}]


def _require_ascending(chapters: list[Chapter]) -> list[Chapter]:
    if len(chapters) < 2:
        return []
    for i in range(1, len(chapters)):
        if chapters[i]["start_sec"] <= chapters[i - 1]["start_sec"]:
            return []
    return chapters


def _parse_cue_ts(raw: str) -> float:
    match = _CUE_TS_RE.match((raw or "").strip())
    if not match:
        return 0.0
    hour, minute, sec, frac = match.groups()
    ms = 0.0
    if frac:
        ms = int(frac.ljust(3, "0")[:3]) / 1000.0
    return (int(hour) * 3600 if hour else 0) + int(minute) * 60 + int(sec) + ms


def _decode_vtt_entities(raw: str) -> str:
    def repl(match: re.Match[str]) -> str:
        ent = match.group(1)
        if ent.startswith("#"):
            try:
                code = int(ent[2:], 16) if ent[1] in "xX" else int(ent[1:])
            except ValueError:
                return " "
            if code in (160, 0x202F, 0x2007):
                return " "
            try:
                return chr(code)
            except ValueError:
                return " "
        mapped = _NAMED_VTT_ENTITIES.get(ent.lower())
        if mapped is not None:
            return mapped
        return " "

    out = raw
    for _ in range(3):
        nxt = _VTT_ENTITY_RE.sub(repl, out)
        if nxt == out:
            break
        out = nxt
    return out


def _clean_cue_text(raw: str) -> str:
    text = _decode_vtt_entities(raw)
    text = re.sub(r"<[^>]+>", "", text)
    text = _decode_vtt_entities(text)
    return re.sub(r"\s+", " ", text).strip()


def _downsample_cues(
    cues: list[tuple[float, str]], window_sec: float
) -> list[tuple[float, str]]:
    if not cues:
        return []
    windows: list[tuple[float, str]] = []
    start = cues[0][0]
    parts = [cues[0][1]]
    for ts, text in cues[1:]:
        if ts >= start + window_sec:
            windows.append((start, " ".join(parts).strip()))
            start = ts
            parts = [text]
            continue
        if not parts or parts[-1] != text:
            parts.append(text)
    if parts:
        windows.append((start, " ".join(parts).strip()))
    return [(t, body) for t, body in windows if body]


def _fmt_ts(sec: float) -> str:
    total = int(max(0, math.floor(sec)))
    hours, rem = divmod(total, 3600)
    minutes, seconds = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def _even_indices(n: int, k: int) -> list[int]:
    if n <= 0:
        return []
    if k >= n:
        return list(range(n))
    if k <= 1:
        return [0]
    if k == 2:
        return [0, n - 1]
    out = [round(i * (n - 1) / (k - 1)) for i in range(k)]
    deduped: list[int] = []
    for idx in out:
        if not deduped or idx != deduped[-1]:
            deduped.append(idx)
    if deduped[-1] != n - 1:
        deduped[-1] = n - 1
    return deduped


def _title_from_cue(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    if not cleaned:
        return "Chapter"
    title = " ".join(cleaned.split()[:7])
    if len(title) > 80:
        title = title[:80].rsplit(" ", 1)[0].strip()
    title = title.strip(" -–—:|.,;")
    return title or "Chapter"


def _truncate_transcript(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars].rsplit("\n", 1)[0].strip()
    return cut or text[:max_chars]


_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "and",
        "or",
        "to",
        "of",
        "in",
        "on",
        "for",
        "with",
        "at",
        "by",
        "from",
        "as",
        "is",
        "are",
        "was",
        "be",
        "this",
        "that",
        "it",
        "its",
        "into",
        "about",
        "over",
        "just",
        "so",
        "we",
        "you",
        "they",
        "i",
        "i'm",
        "we're",
        "gonna",
        "going",
        "get",
        "got",
        "like",
        "right",
        "okay",
        "ok",
        "yeah",
        "um",
        "uh",
        "really",
        "very",
        "some",
        "more",
        "new",
        "one",
        "our",
        "your",
        "here",
        "there",
        "then",
        "than",
        "but",
        "not",
        "can",
        "will",
        "let's",
        "lets",
        "talk",
        "talking",
        "start",
        "starting",
    }
)


def _content_tokens(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9']+", (text or "").lower())
    toks = {w for w in words if len(w) > 2 and w not in _STOPWORDS}
    extra: set[str] = set()
    for w in toks:
        if w.endswith("s") and len(w) > 4:
            extra.add(w[:-1])
        elif len(w) > 3:
            extra.add(w + "s")
        if w in {"chassis", "case", "cases"}:
            extra.update({"chassis", "case", "cases", "sff"})
        if w == "sff":
            extra.update({"chassis", "case", "cases"})
    return toks | extra


def _fit_transcript_windows(
    windows: list[tuple[float, str]], max_chars: int
) -> str:
    """Keep every window timestamp if possible by shortening cue text first."""

    def render(max_words: int) -> str:
        lines: list[str] = []
        for start, text in windows:
            words = text.split()
            body = " ".join(words[:max_words]) if max_words > 0 else ""
            if body:
                lines.append(f"[{_fmt_ts(start)}] {body}")
            else:
                lines.append(f"[{_fmt_ts(start)}]")
        return "\n".join(lines)

    full = render(10_000)
    if len(full) <= max_chars:
        return full
    lo, hi = 1, 24
    best = ""
    while lo <= hi:
        mid = (lo + hi) // 2
        text = render(mid)
        if len(text) <= max_chars:
            best = text
            lo = mid + 1
        else:
            hi = mid - 1
    if best:
        return best
    short = render(1)
    if len(short) <= max_chars:
        return short
    return ""


def _topic_onset(
    start_sec: float,
    title: str,
    cues: list[tuple[float, str]],
    *,
    prev_start: Optional[float],
    lookback: float = TOPIC_LOOKBACK_SEC,
) -> float:
    """Walk captions backward from a late marker to the first on-topic cue."""
    if not cues:
        return max(0.0, start_sec)
    idx = 0
    best = abs(cues[0][0] - start_sec)
    for i, (ts, _) in enumerate(cues[1:], start=1):
        delta = abs(ts - start_sec)
        if delta < best or (
            abs(delta - best) <= SNAP_EARLIER_TIE_SEC and ts < cues[idx][0]
        ):
            idx = i
            best = delta
    sig = _content_tokens(title)
    for ts, text in cues:
        if abs(ts - start_sec) <= TOPIC_NEIGHBOR_SEC:
            sig |= _content_tokens(text)
    if len(sig) < 2:
        return cues[idx][0]
    floor = start_sec - lookback
    if prev_start is not None:
        floor = max(floor, float(prev_start) + 1.0)
    earliest = idx
    gaps = 0
    for i in range(idx - 1, -1, -1):
        ts, text = cues[i]
        if ts < floor:
            break
        tok = _content_tokens(text)
        if not tok:
            continue
        if tok & sig:
            earliest = i
            gaps = 0
        else:
            gaps += 1
            if gaps >= 2:
                break
    return cues[earliest][0]


def _snap_to_cues(start_sec: float, cue_starts: list[float]) -> float:
    if not cue_starts:
        return max(0.0, start_sec)
    nearest = min(cue_starts, key=lambda ts: (abs(ts - start_sec), ts))
    if nearest > start_sec:
        earlier = [ts for ts in cue_starts if ts <= start_sec]
        if earlier:
            last_before = max(earlier)
            if start_sec - last_before <= abs(nearest - start_sec) + SNAP_EARLIER_TIE_SEC:
                return last_before
    return nearest
