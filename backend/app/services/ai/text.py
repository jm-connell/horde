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
        "Suggest additional short topical tags for this archived video. "
        "Return JSON: {\"tags\": [\"tag1\", \"tag2\", ...]}. "
        "Use 3-12 short tags (1-3 words). Do not repeat existing tags. "
        "Prefer general topics over proper nouns unless distinctive.\n\n"
        f"Title: {video.title}\n"
        f"Channel: {video.channel or ''}\n"
        f"Existing tags: {', '.join(existing_tags) or '(none)'}\n"
        f"Description: {desc or '(none)'}\n"
        f"Subtitle excerpt: {excerpt or '(none)'}\n"
    )


def category_prompt(sample_titles: list[str]) -> str:
    joined = "\n".join(f"- {t}" for t in sample_titles[:40])
    return (
        "Given these video titles from a personal archive, propose 8-15 very short "
        "general browse categories like YouTube chips (e.g. Gaming, Cooking, Travel, "
        "Music, Tech, Science, DIY, Comedy). Return JSON: "
        "{\"categories\": [\"Gaming\", \"Cooking\", ...]}. "
        "Categories must be 1-2 words, broad, and relevant to the sample.\n\n"
        f"Titles:\n{joined}\n"
    )


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
