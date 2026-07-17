"""Build text corpora for embeddings and LLM prompts from video metadata + VTT."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any, Literal, Optional

from ...config import DOWNLOADS_DIR
from ...models import Video
from .. import library

# Rough char budget for subtitle chunks (~500–800 tokens).
_CHUNK_CHARS = 2800
_MAX_SUBTITLE_CHARS = 80_000
_MAX_DESCRIPTION_CHARS = 4000
_MAX_NOTES_CHARS = 2000


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
        if s.startswith("NOTE") or s.startswith("STYLE") or s.startswith("REGION"):
            continue
        # Drop simple cue settings / tags.
        s = re.sub(r"<[^>]+>", "", s)
        s = re.sub(r"&nbsp;", " ", s)
        s = re.sub(r"&amp;", "&", s)
        s = re.sub(r"&lt;", "<", s)
        s = re.sub(r"&gt;", ">", s)
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
        path = DOWNLOADS_DIR / str(rel)
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


_SUMMARY_DESC_CHARS = 1500
SummaryLength = Literal["short", "medium", "long"]

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
    if value in _SUMMARY_LENGTH_SPEC:
        return value  # type: ignore[return-value]
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
        s.strip()
        for s in re.split(r"(?<=[.!?])\s+", truncated)
        if s and s.strip()
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
) -> str:
    """Ask for a continuation only — more reliable than a full rewrite on small models."""
    length_key = normalize_summary_length(length)
    spec = _SUMMARY_LENGTH_SPEC[length_key]
    words = count_words(draft)
    need = max(60, int(need_words))
    sub = load_subtitle_text(video, max_chars=int(spec["sub_chars"]))
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

    # Single newlines inside a "paragraph" → spaces (models often soft-wrap).
    parts = [re.sub(r"\n+", " ", p).strip() for p in parts]

    length_key = normalize_summary_length(length)
    # Cap at 2–3 paragraphs for readable blurbs (short stays 1–2).
    target_paras = {"short": 2, "medium": 2, "long": 3}[length_key]
    max_paras = {"short": 2, "medium": 3, "long": 3}[length_key]

    if len(parts) == 1 and length_key != "short":
        sentences = [
            s.strip()
            for s in _SENTENCE_SPLIT.split(parts[0])
            if s and s.strip()
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
    while len(parts) > max_paras:
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
) -> str:
    length_key = normalize_summary_length(length)
    spec = _SUMMARY_LENGTH_SPEC[length_key]
    desc = re.sub(r"\s+", " ", (video.description or "").strip())[:_SUMMARY_DESC_CHARS]
    sub = load_subtitle_text(video, max_chars=int(spec["sub_chars"]))
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
        "not framing like \"In this archived video…\", \"In the video…\", "
        "\"The creator [name] does…\", or \"This video is about…\". "
        "Do not invent example topics from these instructions.\n"
        + (
            f"- Prefer using the channel name ({channel}) as a natural subject "
            "when it fits; do not introduce them as \"the creator\".\n"
            if channel
            else ""
        )
        + "- Cover the main topics and tone; stay spoiler-light.\n"
        "- Recognize sponsor/ad reads (phrases like \"thanks to today's sponsor\", "
        "\"brought to you by\", \"this video is sponsored by\") and skip them — "
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


def tag_enrich_prompt(video: Video, existing_tags: list[str]) -> str:
    excerpt = subtitle_excerpt(video)
    desc = (video.description or "")[:2000]
    return (
        "Suggest a complete set of short topical tags for this archived video.\n"
        "Return JSON: {\"tags\": [\"tag1\", \"tag2\", ...]}.\n"
        "Rules:\n"
        "- Return 3-12 short tags (1-3 words each) that are useful for browsing/search.\n"
        "- Compare carefully against Existing tags; only add tags that fill real gaps.\n"
        "- Do not repeat existing tags or near-duplicates (singular/plural, "
        "\"Fight\" vs \"Fights\", reordered words, minor wording changes).\n"
        "- Prefer general topics over proper nouns unless distinctive.\n"
        "- If existing tags already cover the video well, return fewer new tags "
        "(or an empty list) rather than inventing redundant ones.\n\n"
        f"Title: {video.title}\n"
        f"Channel: {video.channel or ''}\n"
        f"Existing tags: {', '.join(existing_tags) or '(none)'}\n"
        f"Description: {desc or '(none)'}\n"
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
        "universal mega-buckets when the sample supports it. Avoid near-duplicate "
        "names. Reply with JSON only."
    )


def category_prompt(entries: list[str]) -> str:
    """Build the invent prompt from preformatted sample video entries."""
    body = "\n\n".join(entries)
    return (
        "Given these videos from a personal archive, propose 8-15 browse categories "
        "specific to this library.\n"
        "Rules:\n"
        "- Prefer concrete topics (e.g. Homelab Networking, Mechanical Keyboards) "
        "over mega-buckets (Tech, Gaming) when the sample supports it.\n"
        "- Names should be about 2-4 words.\n"
        "- Avoid near-duplicates (Tech vs Technology, same topic reworded).\n"
        "- Each category needs a short one-line blurb describing what belongs in it.\n"
        "Return JSON:\n"
        '{"categories": [{"name": "Homelab Networking", '
        '"blurb": "Routers, VLANs, self-hosted infra"}, ...]}\n\n'
        f"Videos:\n{body}\n"
    )


def category_embed_text(
    name: str, blurb: str = "", *, example_titles: Optional[list[str]] = None
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
        "{\"verdict\": \"same\"|\"similar\"|\"different\", \"confidence\": 0.0-1.0, "
        "\"reason\": \"short\"}.\n\n"
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
        "You are a helpful assistant for a personal video library. "
        "Answer questions about the current video using only the provided "
        "metadata, description, notes, and caption excerpts. "
        "Be concise and specific. If the context does not contain the answer, "
        "say you do not know rather than inventing details. "
        "Do not output JSON unless the user asks for it."
    )


def format_chat_context(
    *,
    metadata: str,
    caption_chunks: list[str],
    summary: Optional[str] = None,
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
    sub = load_subtitle_text(video, max_chars=_CHAT_FALLBACK_SUB_CHARS)
    if not sub.strip():
        return []
    return [sub]


def resolve_subtitle_path(rel: Optional[str]) -> Optional[Path]:
    if not rel:
        return None
    path = DOWNLOADS_DIR / rel
    return path if path.is_file() else None
