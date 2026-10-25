"""Build text corpora for embeddings and LLM prompts from video metadata + VTT."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any, Literal, get_args

from ...context import get_paths
from ...models import Video
from .. import library

# Rough char budget for subtitle chunks (~500–800 tokens).
_CHUNK_CHARS = 2800
_MAX_SUBTITLE_CHARS = 80_000
_MAX_DESCRIPTION_CHARS = 4000
_MAX_NOTES_CHARS = 2000

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


def _decode_vtt_entities(raw: str) -> str:
    """Decode HTML/YouTube entities; unknown named ones (nsps, npsp, …) become a space."""

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


def strip_vtt(raw: str) -> str:
    """Plain caption text from a WebVTT document."""
    return _strip_vtt(raw)


def _strip_vtt(raw: str) -> str:
    lines: list[str] = []
    for line in raw.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.upper().startswith("WEBVTT"):
            continue
        if s.isdigit():
            continue
        if "-->" in s:
            continue
        if s.startswith(("NOTE", "STYLE", "REGION")):
            continue
        # Drop simple cue settings / tags and leftover HTML/YouTube entities.
        s = _decode_vtt_entities(s)
        s = re.sub(r"<[^>]+>", "", s)
        s = _decode_vtt_entities(s)
        s = re.sub(r"\s+", " ", s).strip()
        if s:
            lines.append(s)
    # Collapse consecutive duplicates common in auto-captions.
    out: list[str] = []
    prev = ""
    for line in lines:
        if line == prev:
            continue
        out.append(line)
        prev = line
    return " ".join(out)


def load_subtitle_text(video: Video, *, max_chars: int = _MAX_SUBTITLE_CHARS) -> str:
    tracks = library.parse_subtitles(video.subtitles)
    if not tracks:
        return ""

    # Prefer non-auto English-ish tracks, then any non-auto, then auto.
    def rank(t: dict) -> tuple[int, int]:
        lang = str(t.get("lang") or "").lower()
        auto = 1 if t.get("auto") else 0
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
            text = _strip_vtt(path.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
        if text:
            return text[:max_chars]
    return ""


def metadata_document(video: Video) -> str:
    tags = library.parse_tags(video.tags)
    parts = [
        f"Title: {video.title or ''}",
        f"Channel: {video.channel or ''}",
    ]
    if tags:
        parts.append("Tags: " + ", ".join(tags))
    if video.description:
        parts.append("Description: " + video.description[:_MAX_DESCRIPTION_CHARS])
    if video.notes:
        parts.append("Notes: " + video.notes[:_MAX_NOTES_CHARS])
    return "\n".join(parts).strip()


def chunk_text(text: str, *, chunk_chars: int = _CHUNK_CHARS) -> list[str]:
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    if len(text) <= chunk_chars:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + chunk_chars)
        if end < len(text):
            # Prefer break on sentence / space.
            window = text[start:end]
            break_at = max(window.rfind(". "), window.rfind(" "))
            if break_at > chunk_chars // 3:
                end = start + break_at + 1
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end
    return chunks


def documents_for_video(
    video: Video, *, use_subtitles: bool = True
) -> list[tuple[int, str]]:
    """Return (chunk_index, text) pairs. chunk_index -1 is metadata."""
    docs: list[tuple[int, str]] = [(-1, metadata_document(video))]
    if use_subtitles:
        sub = load_subtitle_text(video)
        for i, chunk in enumerate(chunk_text(sub)):
            docs.append((i, chunk))
    return docs


def content_hash(video: Video, *, use_subtitles: bool = True) -> str:
    docs = documents_for_video(video, use_subtitles=use_subtitles)
    h = hashlib.sha256()
    for idx, text in docs:
        h.update(f"{idx}:".encode())
        h.update(text.encode("utf-8", errors="ignore"))
        h.update(b"\n")
    return h.hexdigest()


def subtitle_excerpt(video: Video, *, max_chars: int = 1500) -> str:
    return load_subtitle_text(video, max_chars=max_chars)


def has_subtitle_text(video: Video) -> bool:
    return bool(load_subtitle_text(video, max_chars=64).strip())


def _captions(video: Video, subtitle_text: str | None, *, max_chars: int) -> str:
    """Caption text for a prompt: the given text (a stream's), else the files."""
    if subtitle_text is not None:
        return subtitle_text[:max_chars]
    return load_subtitle_text(video, max_chars=max_chars)


_SUMMARY_DESC_CHARS = 1500
SummaryLength = Literal["short", "medium", "long"]
_SUMMARY_LENGTHS: tuple[SummaryLength, ...] = get_args(SummaryLength)

# Constrained decoding so json_object mode cannot legally emit `{  }`.
SUMMARY_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": "Spoiler-light video summary; paragraph breaks as \\n\\n",
        }
    },
    "required": ["summary"],
    "additionalProperties": False,
}

# Caps for stored text; prompts aim lower so models stay in range.
_SUMMARY_LENGTH_SPEC: dict[str, dict[str, Any]] = {
    "short": {
        "label": "SHORT",
        "sub_chars": 10_000,
        "max_chars": 1400,
        "word_range": "75–120",
        "min_words": 70,
        "max_words": 125,
        "num_predict": 1100,
        "length_rule": (
            "1–2 short paragraphs separated by a blank line. "
            "Stay within roughly 75–120 words; do not pad toward medium/long."
        ),
        "detail_rule": (
            "Include specific names, games, products, places, or numbers from "
            "the captions when they matter — avoid vague filler."
        ),
    },
    "medium": {
        "label": "MEDIUM",
        "sub_chars": 16_000,
        "max_chars": 2800,
        "word_range": "200–280",
        "min_words": 180,
        "max_words": 300,
        "num_predict": 2200,
        "length_rule": (
            "2–3 paragraphs separated by blank lines, covering setup, main beats, "
            "and concrete details. Aim for about 200–280 words — longer than a "
            "short blurb, shorter than long. Do not start a new paragraph every sentence."
        ),
        "detail_rule": (
            "Name concrete details from the captions: people, titles, gear, "
            "locations, scores, and notable moments — not just high-level themes."
        ),
    },
    "long": {
        "label": "LONG",
        "sub_chars": 24_000,
        "max_chars": 3500,
        "word_range": "300–400",
        "min_words": 280,
        "max_words": 420,
        "num_predict": 3200,
        "length_rule": (
            "2–3 paragraphs separated by blank lines, walking through the arc "
            "with specific beats. Target about 350 words (roughly 300–400). "
            "A ~100–200 word blurb is too short for LONG. "
            "Do not start a new paragraph every sentence."
        ),
        "detail_rule": (
            "Be specific with grounded detail from the captions: named subjects, "
            "what was demoed or argued, gear/settings mentioned, notable beats in order, "
            "and distinctive quotes when useful. Prefer concrete over generic."
        ),
    },
}

# Back-compat alias used by tasks for a hard ceiling when length is unknown.
SUMMARY_MAX_CHARS = int(_SUMMARY_LENGTH_SPEC["long"]["max_chars"])


def normalize_summary_length(raw: Any) -> SummaryLength:
    value = str(raw or "").strip().lower()
    for length in _SUMMARY_LENGTHS:
        if value == length:
            return length
    return "short"


def summary_max_chars(length: SummaryLength | str | None = None) -> int:
    spec = _SUMMARY_LENGTH_SPEC[normalize_summary_length(length)]
    return int(spec["max_chars"])


def summary_num_predict(length: SummaryLength | str | None = None) -> int:
    spec = _SUMMARY_LENGTH_SPEC[normalize_summary_length(length)]
    return int(spec["num_predict"])


def summary_word_bounds(
    length: SummaryLength | str | None = None,
) -> tuple[int, int]:
    spec = _SUMMARY_LENGTH_SPEC[normalize_summary_length(length)]
    return int(spec["min_words"]), int(spec["max_words"])


def count_words(text: str) -> int:
    return len((text or "").split())


def trim_to_max_words(text: str, max_words: int) -> str:
    """Trim at a sentence boundary when over max_words; else hard word cut."""
    words = (text or "").split()
    if max_words <= 0 or len(words) <= max_words:
        return (text or "").strip()
    truncated = " ".join(words[:max_words]).strip()
    # Prefer ending on a sentence if we still have most of the budget.
    sentences = [
        s.strip() for s in re.split(r"(?<=[.!?])\s+", truncated) if s and s.strip()
    ]
    if len(sentences) >= 2:
        kept: list[str] = []
        total = 0
        for sentence in sentences:
            n = len(sentence.split())
            if total + n > max_words and kept:
                break
            kept.append(sentence)
            total += n
        if kept:
            return " ".join(kept).strip()
    return truncated


def summary_continue_prompt(
    video: Video,
    draft: str,
    *,
    length: SummaryLength | str | None = None,
    need_words: int,
    subtitle_text: str | None = None,
) -> str:
    """Ask for a continuation only — more reliable than a full rewrite on small models."""
    length_key = normalize_summary_length(length)
    spec = _SUMMARY_LENGTH_SPEC[length_key]
    words = count_words(draft)
    need = max(60, int(need_words))
    sub = _captions(video, subtitle_text, max_chars=int(spec["sub_chars"]))
    return (
        f"Length setting: {spec['label']}\n"
        f"The draft below is only {words} words; we need about {need} more words.\n"
        "Write ONLY the continuation (new sentences). Do not repeat the draft. "
        "Add concrete caption details not yet covered (names, gear, places, beats). "
        "Do not invent facts. Keep it spoiler-light.\n"
        'Return JSON only: {"summary": "<continuation text>"}.\n\n'
        f"Title: {video.title or ''}\n"
        f"Channel: {(video.channel or '').strip() or '(none)'}\n"
        f"Draft so far ({words} words):\n{draft.strip()}\n\n"
        f"Captions:\n{sub or '(none)'}\n\n"
        f"Reminder: output ~{need} new words of continuation for {spec['label']}.\n"
    )


_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'])")


def format_summary_paragraphs(
    text: str,
    *,
    length: SummaryLength | str | None = None,
) -> str:
    """Normalize blank-line paragraphs; split long single blocks for medium/long."""
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return ""

    # Collapse runs of spaces/tabs but keep newlines.
    raw = re.sub(r"[ \t]+", " ", raw)
    raw = re.sub(r" *\n *", "\n", raw)

    parts = [p.strip() for p in re.split(r"\n\s*\n+", raw) if p.strip()]
    if not parts:
        parts = [raw]

    # Single newlines inside a "paragraph" → spaces (models often soft-wrap),
    # but keep list structure so bullet/numbered lines stay on separate lines.
    def _normalize_part(p: str) -> str:
        lines = [ln.rstrip() for ln in p.split("\n")]
        list_lines = sum(
            1 for ln in lines if re.match(r"^\s*(?:[-*+]|\d+[.)])\s+\S", ln)
        )
        if list_lines >= 1 and list_lines >= max(
            1, len([ln for ln in lines if ln.strip()]) - 1
        ):
            # Preserve newlines for list-heavy blocks; drop empties inside.
            kept = [ln.strip() for ln in lines if ln.strip()]
            return "\n".join(kept)
        return re.sub(r"\n+", " ", p).strip()

    parts = [_normalize_part(p) for p in parts]

    length_key = normalize_summary_length(length)
    # Cap at 2–3 paragraphs for readable blurbs (short stays 1–2).
    target_paras = {"short": 2, "medium": 2, "long": 3}[length_key]
    max_paras = {"short": 2, "medium": 3, "long": 3}[length_key]

    def _is_list_part(p: str) -> bool:
        lines = [ln for ln in p.split("\n") if ln.strip()]
        if not lines:
            return False
        hits = sum(1 for ln in lines if re.match(r"^\s*(?:[-*+]|\d+[.)])\s+\S", ln))
        return hits >= 1 and hits >= len(lines) - 1

    if len(parts) == 1 and length_key != "short" and not _is_list_part(parts[0]):
        sentences = [
            s.strip() for s in _SENTENCE_SPLIT.split(parts[0]) if s and s.strip()
        ]
        if len(sentences) >= 2:
            # Chunk sentences into ~target_paras groups.
            n = max(2, min(target_paras, len(sentences)))
            chunk = max(1, (len(sentences) + n - 1) // n)
            parts = []
            for i in range(0, len(sentences), chunk):
                chunk_text = " ".join(sentences[i : i + chunk]).strip()
                if chunk_text:
                    parts.append(chunk_text)
            # Avoid a tiny leftover paragraph — merge into previous.
            if len(parts) > 1 and len(parts[-1].split()) < 25:
                parts[-2] = f"{parts[-2]} {parts[-1]}".strip()
                parts.pop()

    # Models often emit one sentence per paragraph — fold extras into the last.
    # Keep list blocks intact (don't merge them into neighboring prose).
    while len(parts) > max_paras:
        if _is_list_part(parts[-1]) or _is_list_part(parts[-2]):
            break
        parts[-2] = f"{parts[-2]} {parts[-1]}".strip()
        parts.pop()

    return "\n\n".join(parts)


def summary_system_prompt(length: SummaryLength | str | None = None) -> str:
    length_key = normalize_summary_length(length)
    spec = _SUMMARY_LENGTH_SPEC[length_key]
    return (
        f"You write video summaries for a personal library. "
        f"This request is {spec['label']}. "
        f"Target word count for the summary field: {spec['word_range']} words. "
        "Hit that range — do not write a short blurb when medium/long is requested. "
        "Start immediately with what happens or what the video is about — "
        "like a blurb, not a meta description. "
        "Prefer specifics and concrete details from the source over vague "
        "generalities. "
        'Reply with JSON only: {"summary": "..."} — put paragraph breaks as '
        "escaped newlines (\\n\\n) inside the summary string."
    )


def summary_prompt(
    video: Video,
    *,
    length: SummaryLength | str | None = None,
    subtitle_text: str | None = None,
) -> str:
    length_key = normalize_summary_length(length)
    spec = _SUMMARY_LENGTH_SPEC[length_key]
    desc = re.sub(r"\s+", " ", (video.description or "").strip())[:_SUMMARY_DESC_CHARS]
    sub = _captions(video, subtitle_text, max_chars=int(spec["sub_chars"]))
    channel = (video.channel or "").strip()
    return (
        f"Length setting: {spec['label']}\n"
        f"Target word count: {spec['word_range']} words "
        "(count the words in the summary text; stay in this range).\n\n"
        "Write a spoiler-light summary before watching.\n"
        "Rules:\n"
        '- Return JSON: {"summary": "..."}.\n'
        "- Put paragraph breaks inside the summary string as \\n\\n "
        "(escaped newlines), not as raw line breaks outside JSON.\n"
        f"- Word count: write about {spec['word_range']} words. "
        f"{spec['length_rule']}\n"
        f"- Detail: {spec['detail_rule']}\n"
        "- Open with the substance of this video (topic, action, or subject) — "
        'not framing like "In this archived video…", "In the video…", '
        '"The creator [name] does…", or "This video is about…". '
        "Do not invent example topics from these instructions.\n"
        + (
            f"- Prefer using the channel name ({channel}) as a natural subject "
            'when it fits; do not introduce them as "the creator".\n'
            if channel
            else ""
        )
        + "- Cover the main topics and tone; stay spoiler-light.\n"
        '- Recognize sponsor/ad reads (phrases like "thanks to today\'s sponsor", '
        '"brought to you by", "this video is sponsored by") and skip them — '
        "do not summarize the ad pitch as part of the video; focus on the actual content.\n"
        "- Do not invent details absent from the captions/metadata.\n"
        "- Do not use bullet lists or headings.\n\n"
        f"Title: {video.title or ''}\n"
        f"Channel: {channel or '(none)'}\n"
        f"Description: {desc or '(none)'}\n"
        f"Captions:\n{sub or '(none)'}\n\n"
        f"Reminder: {spec['label']} summary, target word count "
        f"{spec['word_range']} words.\n"
    )


def tag_enrich_prompt(
    video: Video, existing_tags: list[str], library_tags: list[str] | None = None
) -> str:
    """``library_tags`` are the library's most used tags, offered for reuse."""
    excerpt = subtitle_excerpt(video)
    desc = (video.description or "")[:2000]
    vocabulary = (
        "- When a tag from Library tags fits, use it with that exact spelling "
        "instead of a synonym or variant, so related videos share tags. Only "
        "use the ones that truly apply.\n"
        if library_tags
        else ""
    )
    return (
        "Suggest a complete set of short topical tags for this archived video.\n"
        'Return JSON: {"tags": ["tag1", "tag2", ...], "remove": ["bad1", ...]}.\n'
        "Rules:\n"
        '- In "tags", return 3-12 short tags (1-3 words each) that fill real gaps '
        "for browsing/search (or fewer / empty if coverage is already good).\n"
        "- Compare carefully against Existing tags; only add tags that fill real gaps.\n"
        "- Do not repeat existing tags or near-duplicates (singular/plural, "
        '"Fight" vs "Fights", reordered words, minor wording changes).\n'
        "- Prefer general topics over proper nouns unless distinctive.\n"
        '- In "remove", list Existing tags that are wrong, off-topic, or redundant '
        "for this video. Prefer removing poor AI guesses; leave correct tags alone. "
        "Use an empty list when nothing should be removed.\n"
        "- If existing tags already cover the video well, return fewer new tags "
        "(or an empty list) rather than inventing redundant ones.\n"
        f"{vocabulary}\n"
        f"Title: {video.title}\n"
        f"Channel: {video.channel or ''}\n"
        f"Existing tags: {', '.join(existing_tags) or '(none)'}\n"
        + (f"Library tags: {', '.join(library_tags)}\n" if library_tags else "")
        + f"Description: {desc or '(none)'}\n"
        f"Subtitle excerpt: {excerpt or '(none)'}\n"
    )


def _first_sentence_or_chars(text: str, *, max_chars: int = 120) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return ""
    # Prefer a sentence break within the budget.
    window = text[: max_chars + 1]
    for sep in (". ", "! ", "? "):
        idx = window.find(sep)
        if idx >= 12:
            return text[: idx + 1].strip()
    return text[:max_chars].strip()


_CATEGORY_DESC_CHARS = 300
_CATEGORY_SUB_CHARS = 120
_CATEGORY_SAMPLE_BUDGET = 28_000


def category_sample_entry(
    video: Video,
    *,
    use_subtitles: bool = True,
    desc_chars: int = _CATEGORY_DESC_CHARS,
    sub_chars: int = _CATEGORY_SUB_CHARS,
) -> str:
    """Compact metadata block for category invent prompts."""
    lines = [f"Title: {(video.title or '').strip() or '(untitled)'}"]
    channel = (video.channel or "").strip()
    if channel:
        lines.append(f"Channel: {channel}")
    tags = library.parse_tags(video.tags)[:8]
    if tags:
        lines.append("Tags: " + ", ".join(tags))
    desc = re.sub(r"\s+", " ", (video.description or "").strip())
    if desc:
        lines.append("Description: " + desc[: max(0, desc_chars)])
    if use_subtitles and sub_chars > 0:
        sub = load_subtitle_text(video, max_chars=max(sub_chars * 4, sub_chars))
        excerpt = _first_sentence_or_chars(sub, max_chars=sub_chars)
        if excerpt:
            lines.append("Subtitle: " + excerpt)
    return "\n".join(lines)


def bound_category_entries(
    entries: list[str], *, budget: int = _CATEGORY_SAMPLE_BUDGET
) -> list[str]:
    """Keep entries from the start until the joined sample body hits ``budget``."""
    kept: list[str] = []
    used = 0
    sep_len = 2  # "\n\n" between entries
    for entry in entries:
        add = len(entry) + (sep_len if kept else 0)
        if kept and used + add > budget:
            break
        if not kept and len(entry) > budget:
            kept.append(entry[:budget])
            break
        kept.append(entry)
        used += add
    return kept


def category_system_prompt() -> str:
    return (
        "You invent distinctive browse category chips for a personal video archive. "
        "Cover the sample's main themes. Prefer specific, concrete topics over "
        "universal mega-buckets when the sample supports it. Categories should "
        "overlap little: most videos should clearly fit one category best. Every "
        "category must be backed by videos in the sample. Reply with JSON only."
    )


def category_prompt(entries: list[str]) -> str:
    """Build the invent prompt from preformatted sample video entries.

    Entries are numbered from 1 so the model can name each category's examples.
    """
    body = "\n\n".join(f"[{i}] {entry}" for i, entry in enumerate(entries, 1))
    return (
        "Given these videos from a personal archive, propose 8-15 browse categories "
        "specific to this library.\n"
        "Rules:\n"
        "- Prefer concrete topics (e.g. Homelab Networking, Mechanical Keyboards) "
        "over mega-buckets (Tech, Gaming) when the sample supports it.\n"
        "- Names should be about 2-4 words.\n"
        "- Avoid near-duplicates (Tech vs Technology, same topic reworded) and "
        "categories that mostly contain the same videos.\n"
        "- Group by what a video is about, not by channel or format alone.\n"
        "- Each category needs a short one-line blurb describing what belongs in it.\n"
        '- Each category lists "examples": the numbers of 3-8 sample videos that '
        "clearly belong in it. Skip a category with fewer than 3 clear examples.\n"
        "Return JSON:\n"
        '{"categories": [{"name": "Homelab Networking", '
        '"blurb": "Routers, VLANs, self-hosted infra", "examples": [4, 17, 23]}, ...]}\n\n'
        f"Videos:\n{body}\n"
    )


def category_embed_text(
    name: str, blurb: str = "", *, example_titles: list[str] | None = None
) -> str:
    """Text embedded for category↔video matching."""
    label = (name or "").strip()
    about = (blurb or "").strip()
    lines = [f"Category: {label}"]
    if about:
        lines.append(f"About: {about}")
    titles = [t.strip() for t in (example_titles or []) if t and str(t).strip()]
    if titles:
        lines.append("Examples: " + " | ".join(titles[:5]))
    if len(lines) == 1 and not about:
        return label
    return "\n".join(lines)


def duplicate_prompt(a: Video, b: Video) -> str:
    return (
        "Decide if these two library entries are the same video, similar content, "
        "or different. Return JSON: "
        '{"verdict": "same"|"similar"|"different", "confidence": 0.0-1.0, '
        '"reason": "short"}.\n\n'
        f"A title: {a.title}\n"
        f"A channel: {a.channel or ''}\n"
        f"A duration_sec: {a.duration_sec}\n"
        f"A description: {(a.description or '')[:500]}\n\n"
        f"B title: {b.title}\n"
        f"B channel: {b.channel or ''}\n"
        f"B duration_sec: {b.duration_sec}\n"
        f"B description: {(b.description or '')[:500]}\n"
    )


_CHAT_CONTEXT_CHARS = 20_000
_CHAT_FALLBACK_SUB_CHARS = 20_000


def chat_system_prompt() -> str:
    return (
        "You are the assistant in a personal video library, chatting with the "
        "viewer about the video they are watching. Talk like a knowledgeable "
        "friend: natural and direct, with a little warmth, but no gushing, "
        "filler or exclamation-mark enthusiasm. "
        "Answer what was asked. If the viewer just says hello or makes small "
        "talk, reply briefly in kind and offer to help with the video; do not "
        "recite its title, channel or description unprompted. "
        "Use the provided metadata, description, notes and caption excerpts "
        "as your source, and refer to the video, its creator and the people "
        "in it in the third person (never speak as the video). "
        "Keep answers short unless asked for detail. If the context does not "
        "contain the answer, say so plainly rather than inventing details. "
        "Do not output JSON unless the viewer asks for it."
    )


def format_chat_context(
    *,
    metadata: str,
    caption_chunks: list[str],
    summary: str | None = None,
    max_chars: int = _CHAT_CONTEXT_CHARS,
) -> str:
    """Assemble the video context block injected into the chat system prompt."""
    parts: list[str] = ["Video context:"]
    meta = (metadata or "").strip()
    if meta:
        parts.append(meta)
    summary_text = (summary or "").strip()
    if summary_text:
        parts.append("Existing summary:\n" + summary_text[:2000])
    captions = [c.strip() for c in caption_chunks if c and c.strip()]
    if captions:
        parts.append("Caption excerpts:")
        parts.extend(captions)
    text = "\n\n".join(parts).strip()
    if len(text) > max_chars:
        text = text[:max_chars].rsplit(" ", 1)[0].strip()
    return text


def chat_fallback_captions(video: Video) -> list[str]:
    """Plain subtitle text when embeddings are unavailable."""
    return chat_captions(load_subtitle_text(video, max_chars=_CHAT_FALLBACK_SUB_CHARS))


def chat_captions(text: str) -> list[str]:
    """Caption text as the single chat-context excerpt (for a stream's captions)."""
    sub = (text or "")[:_CHAT_FALLBACK_SUB_CHARS]
    if not sub.strip():
        return []
    return [sub]


def resolve_subtitle_path(rel: str | None) -> Path | None:
    if not rel:
        return None
    path = get_paths().downloads / rel
    return path if path.is_file() else None
