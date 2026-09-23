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
        if i == 0:
            title = "Intro"
        else:
            next_idx = idxs[i + 1] if i + 1 < len(idxs) else len(windows)
            texts = [windows[j][1] for j in range(idx, next_idx)]
            title = topic_title_from_texts(texts or [text])
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
        "Titles are 2–6 word topic labels for the section, "
        'like "Digging for treasure" or "Installing the GPU". '
        "Name the activity or subject. Do not quote a spoken line, "
        "copy transcript text, or include a timestamp or speaker marker. "
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
        "Use numeric start_sec values in seconds (example: 0, 95, 180).\n"
        "Each title names the topic of that section in 2–6 words. "
        'A stretch of talk about digging and getting rich is "Digging for treasure", '
        "not a line someone said.\n\n"
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
    title = _sanitize_chapter_title(title)
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


_SPEAKER_MARK_RE = re.compile(r">{2,}")
_SOUND_TAG_RE = re.compile(
    r"\[\s*(?:music|applause|laughter|laughing|inaudible|silence|noise|"
    r"cheering|crosstalk|background noise)\s*\]",
    re.IGNORECASE,
)
_LEADING_CLOCK_RE = re.compile(
    r"^\s*(?:\[\s*)?(?:(?:\d{1,2}):)?\d{1,2}:\d{2}(?:\.\d{1,3})?\s*\]?\s*"
)
_SPEECH_OPENERS = (
    "all right",
    "alright",
    "okay so",
    "ok so",
    "okay",
    "ok",
    "let's",
    "lets",
    "let us",
    "i'm",
    "i am",
    "we're",
    "we are",
    "you're",
    "you know",
    "hold on",
    "yeah",
    "um",
    "uh",
)
_QUOTE_CUE_WINDOW_SEC = 90.0


def _clean_cue_text(raw: str) -> str:
    text = _decode_vtt_entities(raw)
    text = re.sub(r"<[^>]+>", "", text)
    text = _decode_vtt_entities(text)
    text = _SOUND_TAG_RE.sub(" ", text)
    text = _SPEAKER_MARK_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return _collapse_stutter(text)


def _downsample_cues(
    cues: list[tuple[float, str]], window_sec: float
) -> list[tuple[float, str]]:
    if not cues:
        return []
    windows: list[tuple[float, str]] = []
    start = cues[0][0]
    merged = cues[0][1]
    for ts, text in cues[1:]:
        if ts >= start + window_sec:
            body = _collapse_stutter(merged)
            if body:
                windows.append((start, body))
            start = ts
            merged = text
            continue
        if text and text != merged:
            merged = _merge_rolling(merged, text)
    body = _collapse_stutter(merged)
    if body:
        windows.append((start, body))
    return windows


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


def _norm_words(text: str) -> list[str]:
    cleaned = (text or "").replace("’", "'").replace("‘", "'").lower()
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", cleaned)


def _word_key(word: str) -> str:
    keys = _norm_words(word)
    return keys[0].replace("'", "") if keys else ""


def _cmp_words(text: str) -> list[str]:
    return [word.replace("'", "") for word in _norm_words(text)]


def _merge_rolling(prev: str, nxt: str) -> str:
    """Drop the overlapping prefix when YouTube captions roll forward."""
    prev = (prev or "").strip()
    nxt = (nxt or "").strip()
    if not nxt:
        return prev
    if not prev:
        return nxt
    prev_words = prev.split()
    next_words = nxt.split()
    prev_keys = [_word_key(w) for w in prev_words]
    next_keys = [_word_key(w) for w in next_words]
    if next_keys and len(next_keys) >= 2 and prev_keys[: len(next_keys)] == next_keys:
        return prev
    max_k = min(len(prev_keys), len(next_keys))
    overlap = 0
    for k in range(max_k, 0, -1):
        if prev_keys[-k:] == next_keys[:k]:
            overlap = k
            break
    if overlap == len(next_keys) and overlap:
        return prev
    if overlap:
        kept = list(prev_words)
        if overlap < len(next_words):
            kept[-1] = kept[-1].rstrip(".,;:")
        return " ".join(kept + next_words[overlap:]).strip()
    if len(next_keys) >= 2 and _contains_seq(prev_keys, next_keys):
        return prev
    return " ".join(prev_words + next_words).strip()


def _contains_seq(hay: list[str], needle: list[str]) -> bool:
    n = len(needle)
    if n == 0 or n > len(hay):
        return False
    for i in range(len(hay) - n + 1):
        if hay[i : i + n] == needle:
            return True
    return False


def _collapse_stutter(text: str) -> str:
    """Drop a clause that repeats the previous one, or keep the longer extension."""
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", (text or "").strip()) if p.strip()]
    if len(parts) < 2:
        return (text or "").strip()
    out: list[str] = []
    keys: list[list[str]] = []
    for part in parts:
        nxt = _cmp_words(part)
        if keys and nxt:
            prev = keys[-1]
            if prev == nxt or prev[: len(nxt)] == nxt or prev[-len(nxt) :] == nxt:
                continue
            if nxt[: len(prev)] == prev:
                out[-1] = part
                keys[-1] = nxt
                continue
        out.append(part)
        keys.append(nxt)
    return " ".join(out).strip()


def _sanitize_chapter_title(title: str) -> str:
    text = (title or "").replace("’", "'").replace("‘", "'").strip()
    text = text.strip("\"'“”")
    for _ in range(3):
        nxt = _LEADING_CLOCK_RE.sub("", text)
        nxt = _SPEAKER_MARK_RE.sub(" ", nxt)
        nxt = re.sub(r"\s+", " ", nxt).strip(" \"'“”")
        if nxt == text:
            break
        text = nxt
    text = re.sub(r"\s+", " ", text).strip(" -–—:|.,;")
    return text


def _opens_like_speech(text: str) -> bool:
    words = _norm_words(text)
    if not words:
        return False
    for opener in _SPEECH_OPENERS:
        op_words = opener.split()
        if words[: len(op_words)] == op_words:
            return True
    return False


def _repeats_clause(text: str) -> bool:
    parts = [p.strip() for p in re.split(r"[.!?]+", text) if p.strip()]
    if len(parts) >= 2:
        keys = [_cmp_words(p) for p in parts]
        for i in range(len(keys) - 1):
            a, b = keys[i], keys[i + 1]
            if not a or not b:
                continue
            if a == b or a[: len(b)] == b or b[: len(a)] == a or a[-len(b) :] == b:
                return True
        return False
    words = _cmp_words(text)
    if len(words) < 4:
        return False
    for n in range(2, len(words) // 2 + 1):
        if words[:n] == words[n : n * 2]:
            return True
    return False


def _cue_words_near(
    cues: list[tuple[float, str]], start_sec: float, window: float = _QUOTE_CUE_WINDOW_SEC
) -> list[str]:
    words: list[str] = []
    for ts, text in cues:
        if start_sec - 8.0 <= ts <= start_sec + window:
            words.extend(_norm_words(text))
    return words


def _is_contiguous_quote(title_words: list[str], cue_words: list[str]) -> bool:
    n = len(title_words)
    if n < 4 or n > len(cue_words):
        return False
    for i in range(len(cue_words) - n + 1):
        if cue_words[i : i + n] == title_words:
            return True
    return False


def title_is_spoken_quote(
    title: str,
    cues: list[tuple[float, str]],
    start_sec: float,
) -> bool:
    """True when a title is still a caption line rather than a topic label."""
    text = _sanitize_chapter_title(title)
    if not text:
        return True
    if ">>" in text or _LEADING_CLOCK_RE.match(text):
        return True
    if _opens_like_speech(text) or _repeats_clause(text):
        return True
    words = _norm_words(text)
    return _is_contiguous_quote(words, _cue_words_near(cues, start_sec))


def titles_need_rewrite(
    chapters: list[Chapter], cues: list[tuple[float, str]]
) -> bool:
    return any(
        title_is_spoken_quote(str(chapter["title"]), cues, float(chapter["start_sec"]))
        for chapter in chapters
    )


def _topic_words(text: str) -> list[str]:
    out: list[str] = []
    for word in _norm_words(text):
        if word.isdigit() or len(word) <= 2 or word in _STOPWORDS:
            continue
        out.append(word)
    return out


def topic_title_from_texts(texts: list[str]) -> str:
    """2–3 distinctive words from a segment, not the opening line of a cue."""
    counts: dict[str, int] = {}
    order: list[str] = []
    for text in texts:
        for word in _topic_words(text):
            if word not in counts:
                order.append(word)
            counts[word] = counts.get(word, 0) + 1
    if not counts:
        return "Chapter"
    ranked = sorted(order, key=lambda w: (-counts[w], order.index(w)))
    repeated = [w for w in ranked if counts[w] >= 2]
    picked = repeated[:3] if len(repeated) >= 2 else ranked[:3]
    return " ".join(word.capitalize() for word in picked) or "Chapter"


def _segment_texts(
    chapters: list[Chapter],
    cues: list[tuple[float, str]],
    index: int,
) -> list[str]:
    start = float(chapters[index]["start_sec"])
    if index + 1 < len(chapters):
        end = float(chapters[index + 1]["start_sec"])
    else:
        end = start + 300.0
    texts = [text for ts, text in cues if start - 1.0 <= ts < end]
    if texts:
        return texts
    return [text for ts, text in cues if abs(ts - start) <= 30.0]


def replace_spoken_titles(
    chapters: list[Chapter], cues: list[tuple[float, str]]
) -> list[Chapter]:
    """Swap any remaining caption quotes for a keyword label from that segment."""
    out: list[Chapter] = []
    for i, chapter in enumerate(chapters):
        start = float(chapter["start_sec"])
        title = _sanitize_chapter_title(str(chapter["title"]))
        if not title or title_is_spoken_quote(title, cues, start):
            title = topic_title_from_texts(_segment_texts(chapters, cues, i))
        out.append({"start_sec": start, "title": title})
    return out


def apply_title_rewrites(
    chapters: list[Chapter],
    payload: list[Any],
    cues: list[tuple[float, str]],
) -> list[Chapter]:
    """Keep snapped start times; take a rewrite title when it is a topic label."""
    candidates: list[Chapter] = []
    for item in payload:
        chapter = _coerce_chapter(item)
        if chapter is not None:
            candidates.append(chapter)
    out: list[Chapter] = []
    used: set[int] = set()
    for index, chapter in enumerate(chapters):
        start = float(chapter["start_sec"])
        title = str(chapter["title"])
        cand_i: Optional[int] = None
        if len(candidates) == len(chapters):
            cand_i = index
        else:
            best_delta = 20.0
            for i, cand in enumerate(candidates):
                if i in used:
                    continue
                delta = abs(float(cand["start_sec"]) - start)
                if delta < best_delta:
                    best_delta = delta
                    cand_i = i
        if cand_i is not None:
            used.add(cand_i)
            cand_title = str(candidates[cand_i]["title"])
            if cand_title and not title_is_spoken_quote(cand_title, cues, start):
                title = cand_title
        out.append({"start_sec": start, "title": title})
    return out


def title_rewrite_system_prompt() -> str:
    return (
        "You rewrite video chapter titles into short topic labels. "
        "Reply with JSON only: "
        '{"chapters":[{"start_sec":0,"title":"..."}, ...]}. '
        "Keep each start_sec unchanged. "
        'Titles are 2–6 words naming the topic, like "Digging for treasure". '
        "Do not quote dialogue or include timestamps or speaker markers."
    )


def title_rewrite_prompt(
    chapters: list[Chapter], cues: list[tuple[float, str]]
) -> str:
    blocks: list[str] = []
    for i, chapter in enumerate(chapters):
        start = float(chapter["start_sec"])
        lines: list[str] = []
        used = 0
        for ts, text in cues:
            end = (
                float(chapters[i + 1]["start_sec"])
                if i + 1 < len(chapters)
                else start + 300.0
            )
            if ts < start - 1.0 or ts >= end:
                continue
            line = f"[{_fmt_ts(ts)}] {text}"
            if used and used + len(line) > 800:
                break
            lines.append(line)
            used += len(line) + 1
        start_label = int(start) if start == int(start) else start
        blocks.append(
            f"start_sec: {start_label}\n"
            f"current_title: {chapter['title']}\n"
            "transcript:\n"
            + ("\n".join(lines) if lines else "(no captions)")
        )
    return (
        "Rewrite every current_title into a 2–6 word topic label. "
        "Keep start_sec the same. "
        "If the transcript is people talking about digging and getting rich, "
        'write "Digging for treasure", not a line they said.\n\n'
        + "\n\n".join(blocks)
    )


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
