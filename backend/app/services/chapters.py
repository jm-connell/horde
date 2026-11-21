"""Chapter lists from descriptions, yt-dlp metadata, and timed captions."""

from __future__ import annotations

import json
import math
import re
from typing import Any, Literal

from ..context import get_paths
from ..models import Video, VideoAiMeta
from . import library

ChapterSource = Literal["description", "source", "ai"]
Chapter = dict[str, Any]

# Match frontend parseChapters in utils.ts.
_CHAPTER_LINE_RE = re.compile(
    r"^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\s*[-–—|·•:→]?\s*)(.+)"
)
_PAREN_TITLE_RE = re.compile(r"^\((.+)\)$")

_CUE_TS_RE = re.compile(r"^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$")
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
SNAP_EARLIER_TIE_SEC = 3.0
MUSIC_UNIQUE_RATIO = 0.35
MUSIC_MIN_LINES = 10
MAX_CHAPTERS_HARD = 30

# Characters of timed transcript sent in one model call. A longer transcript is
# read in sections (``transcript_sections``): a local model's context is small
# (by workload profile), and a hosted model with a large one still loses the
# middle of a very long prompt. Whole is better while it fits: a model that
# sees the entire video picks fewer, broader parts than one shown a section.
_TRANSCRIPT_CHARS = {
    "light": 16_000,
    "normal": 32_000,
    "heavy": 48_000,
}
_HOSTED_TRANSCRIPT_CHARS = 48_000

# A chapter this long, and this many times the video's average, is read again
# on its own (``long_chapters``): cheap models sometimes spend their chapters
# on the first half of a long video and file the rest under one title.
LONG_CHAPTER_MIN_SEC = 600.0
LONG_CHAPTER_FACTOR = 2.0

# The model lists the major parts first (a table of contents, no times), then
# gives one start time per part. Asked for timed chapters straight away, cheap
# models mark nearly every transcript line.
CHAPTERS_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "parts": {"type": "array", "items": {"type": "string"}},
        "chapters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "part": {"type": "string"},
                    "start": {"type": "string"},
                },
                "required": ["part", "start"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["parts", "chapters"],
    "additionalProperties": False,
}


def parse_chapters(description: str | None) -> list[Chapter]:
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
        except json.JSONDecodeError, TypeError:
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
        if start is None:
            continue
        try:
            start_sec = float(start)
        except TypeError, ValueError:
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


def ai_chapters_for(meta: VideoAiMeta | None) -> list[Chapter]:
    if meta is None:
        return []
    return parse_chapter_list(getattr(meta, "chapters", None))


def resolve_chapters(
    video: Video, meta: VideoAiMeta | None = None
) -> tuple[list[Chapter], ChapterSource | None]:
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


def transcript_char_cap(profile: Any = None, *, hosted: bool = False) -> int:
    if hosted:
        return _HOSTED_TRANSCRIPT_CHARS
    key = str(profile or "normal").strip().lower()
    return int(_TRANSCRIPT_CHARS.get(key, _TRANSCRIPT_CHARS["normal"]))


def parse_vtt_cues(raw: str) -> list[tuple[float, str]]:
    """Return (start_sec, text) cues, collapsing consecutive duplicate text."""
    cues: list[tuple[float, str]] = []
    pending_start: float | None = None
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
        if s.startswith(("NOTE", "STYLE", "REGION")):
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
        path = get_paths().downloads / str(rel)
        if not path.is_file():
            continue
        try:
            cues = parse_vtt_cues(path.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
        if cues:
            return cues
    return []


def caption_lines(raw_vtt: str, window_sec: float = 5.0) -> list[tuple[float, str]]:
    """Short timed lines of a WebVTT track, with YouTube's rolling repeats removed.

    Each line holds only the words new since the previous one, so joining the
    lines gives the transcript once (Ask stores these to cite exact moments).
    """
    return _fresh_lines(parse_vtt_cues(raw_vtt), window_sec)


def _fresh_lines(
    cues: list[tuple[float, str]], window_sec: float
) -> list[tuple[float, str]]:
    lines: list[tuple[float, str]] = []
    prev = ""
    for start, text in _downsample_cues(cues, window_sec):
        merged = _merge_rolling(prev, text)
        fresh = merged.split()[len(prev.split()) :]
        if fresh:
            lines.append((start, " ".join(fresh)))
        prev = text
    return lines


def transcript_sections(
    cues: list[tuple[float, str]], *, max_chars: int
) -> list[list[tuple[float, str]]]:
    """The timed transcript as lines, in consecutive sections of about
    ``max_chars`` each (one section when it fits).

    Every word is kept: a transcript too long for one model call is read in
    several, not thinned out.
    """
    lines = _fresh_lines(cues, CUE_WINDOW_SEC)
    if not lines:
        return []
    sizes = [len(_render_line(line)) + 1 for line in lines]
    count = max(1, math.ceil(sum(sizes) / max(1, max_chars)))
    per_section = sum(sizes) / count
    sections: list[list[tuple[float, str]]] = [[] for _ in range(count)]
    offset = 0
    for line, size in zip(lines, sizes, strict=True):
        sections[min(count - 1, int(offset / per_section))].append(line)
        offset += size
    return [section for section in sections if section]


def render_transcript(lines: list[tuple[float, str]]) -> str:
    return "\n".join(_render_line(line) for line in lines)


def _render_line(line: tuple[float, str]) -> str:
    return f"[{_fmt_ts(line[0])}] {line[1]}"


def is_music_like(cues: list[tuple[float, str]]) -> bool:
    lines = [text for _, text in cues if text]
    if len(lines) < MUSIC_MIN_LINES:
        return False
    unique = len(set(lines))
    return (unique / len(lines)) < MUSIC_UNIQUE_RATIO


def skip_reason(
    video: Video,
    meta: VideoAiMeta | None = None,
    *,
    force: bool = False,
    cues: list[tuple[float, str]] | None = None,
) -> str | None:
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


def persist_skip_reason(reason: str | None) -> bool:
    """Whether this skip should stick on video_ai_meta (avoid retry loops)."""
    return reason == "music_like"


def min_segment_sec(duration_sec: float | None) -> float:
    if duration_sec is not None and 0 < float(duration_sec) < SHORT_VIDEO_SEC:
        return MIN_SEGMENT_SHORT_SEC
    return MIN_SEGMENT_SEC


def max_chapter_count(duration_sec: float | None) -> int:
    """The most chapters a video of this length may get (a ceiling the model is
    told, not a target): about 6 for 10 minutes, 11 for 40, 16 for 80."""
    if duration_sec is None or duration_sec <= 0:
        return 12
    minutes = float(duration_sec) / 60.0
    return max(2, min(MAX_CHAPTERS_HARD, round(1.8 * math.sqrt(minutes))))


def section_chapter_limit(
    lines: list[tuple[float, str]],
    total_lines: int,
    duration_sec: float | None,
) -> int:
    """The share of ``max_chapter_count`` for one transcript section."""
    share = len(lines) / max(1, total_lines)
    return max(2, round(max_chapter_count(duration_sec) * share))


def snap_and_validate(
    raw_chapters: list[Any],
    cues: list[tuple[float, str]],
    duration_sec: float | None,
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
    filtered: list[Chapter] = []
    for i, chapter in enumerate(deduped):
        next_start = (
            deduped[i + 1]["start_sec"]
            if i + 1 < len(deduped)
            else (
                duration if duration is not None else chapter["start_sec"] + min_seg + 1
            )
        )
        if next_start - chapter["start_sec"] < min_seg:
            continue
        filtered.append(chapter)
    filtered = _merge_shortest(filtered, max_chapter_count(duration), duration)
    if len(filtered) < 2:
        return []
    return filtered


def _merge_shortest(
    chapters: list[Chapter], limit: int, duration: float | None
) -> list[Chapter]:
    """Over ``limit``, fold the shortest chapter into the one before it, again
    and again. The first chapter stays: it holds the start of the video."""
    out = list(chapters)
    while len(out) > max(2, limit):
        ends = [c["start_sec"] for c in out[1:]]
        ends.append(duration if duration is not None else out[-1]["start_sec"] + 1e9)
        shortest = min(range(1, len(out)), key=lambda i: ends[i] - out[i]["start_sec"])
        del out[shortest]
    return out


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
        "You divide a video into chapters so a viewer can jump straight to the "
        "part they want.\n\n"
        "You get the video's title, channel, duration and a timed transcript. "
        "The transcript is auto-generated captions: expect wrong words, no "
        "punctuation and several speakers run together. Each line starts with "
        "the time it is spoken, like [12:34] or [1:02:03].\n\n"
        "Work in two steps, both in one JSON reply.\n\n"
        'Step 1, "parts": read the whole transcript, then list its major parts '
        "in order, as a table of contents written from memory, without times. "
        "A part is a stretch where the video is about one thing: a topic, an "
        "activity or task, a place, a game or match, a guest, a stage of the "
        "story. Think big: a part usually runs for several minutes and holds "
        "many smaller moments. A new sentence, a joke, a short tangent or one "
        "step of a longer task is not a part. A video that stays on one subject "
        "has only 2 or 3 parts. Never list more parts than the limit in the "
        "request; if you count more, your parts are too small, so combine "
        "neighbours under a broader title.\n"
        "Each part is written as its chapter title: 2 to 6 words saying what "
        "happens in it, specific enough that it could not be the title of any "
        "other part. Name the people, places, things, numbers or the event "
        '("Rescuing Tony from the hospital", "4K gaming benchmarks", "Why the '
        'first design failed"). Never a generic label ("Conversation", "Driving '
        'around", "Discussion continues", "More gameplay"), never a line someone '
        "said. Shorter is better: 3 or 4 words is ideal. To quote a word inside "
        "a title use single quotes ('the claw'), never double quotes.\n\n"
        'Step 2, "chapters": find where each part begins. One entry per part, in '
        "the same order, and nothing else:\n"
        '- "part" is the title copied exactly from the parts list.\n'
        '- "start" is the time of the transcript line where that part begins, '
        'copied exactly as written in the brackets (for example "12:34"). Pick '
        "the line where the part starts, not one where it is already under way. "
        "The first part starts at the first line.\n"
        "Parts follow the video, not the clock: one may last a minute, the next "
        "twenty-five.\n\n"
        "Reply with compact JSON only (no line breaks or indentation): "
        '{"parts": ["...", "..."], '
        '"chapters": [{"part": "...", "start": "0:00"}, ...]}'
    )


def chapters_prompt(
    video: Video,
    lines: list[tuple[float, str]],
    *,
    limit: int,
    section: tuple[int, int] = (1, 1),
    previous_title: str | None = None,
    within: str | None = None,
) -> str:
    """The request to divide ``lines`` into parts.

    ``lines`` is the whole transcript, one of its sections (``section`` is its
    1-based number and the section count; ``previous_title`` the chapter the
    video is in when a later section begins) or the stretch of one long chapter
    titled ``within``.
    """
    duration = video.duration_sec
    known = bool(duration and duration > 0)
    duration_label = _fmt_ts(float(duration or 0)) if known else "unknown"
    video_label = (
        f"{round(float(duration or 0) / 60)}-minute video" if known else "video"
    )
    title = (video.title or "").strip() or "Untitled"
    channel = (video.channel or "").strip()
    span = f"from {_fmt_ts(lines[0][0])} to {_fmt_ts(lines[-1][0])}"
    number, total = section
    if within:
        ask = (
            f"This is one stretch of a {video_label}, {span}. It is one chapter "
            f'so far, "{within}". Divide the stretch into its major parts: at '
            f"most {limit}. If it stays on that one subject, list a single part."
        )
    elif total > 1:
        ask = (
            f"This is section {number} of {total} of the transcript of a "
            f"{video_label}, {span}. Divide this section into its major parts: "
            f"at most {limit}, fewer if it has fewer."
        )
    else:
        ask = (
            f"Now divide this {video_label} into its major parts: at most "
            f"{limit}, fewer if it has fewer."
        )
    if previous_title:
        ask += (
            f' Before this section the video was on "{previous_title}". If the '
            "section opens still on that subject, give its first part that "
            "same title, word for word."
        )
    return (
        f"Title: {title}\n"
        f"Channel: {channel}\n"
        f"Duration: {duration_label}\n\n"
        "Timed transcript:\n"
        f"{render_transcript(lines)}\n\n"
        f"{ask}"
    )


def long_chapters(
    chapters: list[Chapter], duration_sec: float | None
) -> list[tuple[int, float]]:
    """``(index, end_sec)`` of the chapters long enough to be read again."""
    if not chapters or not duration_sec or duration_sec <= 0:
        return []
    duration = float(duration_sec)
    threshold = max(
        LONG_CHAPTER_MIN_SEC,
        # Half the video at most, so two or three chapters can still qualify.
        min(LONG_CHAPTER_FACTOR * duration / len(chapters), duration / 2),
    )
    out: list[tuple[int, float]] = []
    for i, chapter in enumerate(chapters):
        end = (
            float(chapters[i + 1]["start_sec"])
            if i + 1 < len(chapters)
            else float(duration_sec)
        )
        if end - float(chapter["start_sec"]) > threshold:
            out.append((i, end))
    return out


def section_chapters(
    payload: list[Any], lines: list[tuple[float, str]]
) -> list[Chapter]:
    """The usable chapters of a model reply about ``lines``: well formed, inside
    the lines it was shown, in order."""
    first, last = lines[0][0], lines[-1][0]
    found: list[Chapter] = []
    for item in payload:
        chapter = _coerce_chapter(item)
        if chapter is None:
            continue
        if not first - CUE_WINDOW_SEC <= chapter["start_sec"] <= last + CUE_WINDOW_SEC:
            continue  # a time from outside what the model was shown
        found.append(chapter)
    found.sort(key=lambda c: c["start_sec"])
    return found


def same_title(title: str, other: str | None) -> bool:
    return bool(other) and _cmp_words(title) == _cmp_words(other or "")


def _coerce_chapter(item: Any) -> Chapter | None:
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
        item.get("title")
        or item.get("part")
        or item.get("name")
        or item.get("label")
        or ""
    ).strip()
    start_sec = _parse_start_value(start)
    if start_sec is None or not title:
        return None
    title = _sanitize_chapter_title(title)
    if not title or len(title) > 120:
        return None
    return {"start_sec": start_sec, "title": title}


def _parse_start_value(raw: Any) -> float | None:
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
    embedded = re.search(r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?", text)
    if embedded:
        return _parse_cue_ts(embedded.group(0))
    return None


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
    return any(hay[i : i + n] == needle for i in range(len(hay) - n + 1))


def _collapse_stutter(text: str) -> str:
    """Drop a clause that repeats the previous one, or keep the longer extension."""
    parts = [
        p.strip() for p in re.split(r"(?<=[.!?])\s+", (text or "").strip()) if p.strip()
    ]
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


def _snap_to_cues(start_sec: float, cue_starts: list[float]) -> float:
    if not cue_starts:
        return max(0.0, start_sec)
    nearest = min(cue_starts, key=lambda ts: (abs(ts - start_sec), ts))
    if nearest > start_sec:
        earlier = [ts for ts in cue_starts if ts <= start_sec]
        if earlier:
            last_before = max(earlier)
            if (
                start_sec - last_before
                <= abs(nearest - start_sec) + SNAP_EARLIER_TIE_SEC
            ):
                return last_before
    return nearest
