"""Build text corpora for embeddings and LLM prompts from video metadata + VTT."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Optional

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


def category_sample_entry(video: Video, *, use_subtitles: bool = True) -> str:
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
        lines.append("Description: " + desc[:_CATEGORY_DESC_CHARS])
    if use_subtitles:
        sub = load_subtitle_text(video, max_chars=_CATEGORY_SUB_CHARS * 4)
        excerpt = _first_sentence_or_chars(sub, max_chars=_CATEGORY_SUB_CHARS)
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


def resolve_subtitle_path(rel: Optional[str]) -> Optional[Path]:
    if not rel:
        return None
    path = DOWNLOADS_DIR / rel
    return path if path.is_file() else None
