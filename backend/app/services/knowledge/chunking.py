"""Timed caption lines and the overlapping passages Ask searches."""

from __future__ import annotations

import json
import zlib
from dataclasses import dataclass

from ..chapters import caption_lines

# Lines are short (a few seconds) so a citation can point at the exact moment.
LINE_WINDOW_SEC = 5.0
# A passage covers about this much speech, overlapping the next by OVERLAP_SEC so a
# point made across a boundary is whole in one of them.
PASSAGE_SEC = 75.0
PASSAGE_MAX_CHARS = 1400
OVERLAP_SEC = 15.0
# The metadata passage (title and description) has this chunk index.
META_CHUNK_INDEX = -1
_META_DESCRIPTION_CHARS = 4000

Line = tuple[float, str]


@dataclass(frozen=True)
class Passage:
    index: int
    start_sec: float
    end_sec: float
    text: str


def lines_from_vtt(raw_vtt: str) -> list[Line]:
    return caption_lines(raw_vtt, LINE_WINDOW_SEC)


def pack_lines(lines: list[Line]) -> bytes:
    data = [[round(start, 2), text] for start, text in lines]
    return zlib.compress(json.dumps(data, ensure_ascii=False).encode("utf-8"))


def unpack_lines(blob: bytes | None) -> list[Line]:
    if not blob:
        return []
    return [(float(s), str(t)) for s, t in json.loads(zlib.decompress(blob))]


def build_passages(lines: list[Line]) -> list[Passage]:
    """Group lines into passages of about ``PASSAGE_SEC`` with ``OVERLAP_SEC`` overlap."""
    passages: list[Passage] = []
    i = 0
    while i < len(lines):
        start = lines[i][0]
        j = i
        chars = 0
        while j < len(lines):
            chars += len(lines[j][1]) + 1
            j += 1
            if chars >= PASSAGE_MAX_CHARS:
                break
            if j < len(lines) and lines[j][0] - start >= PASSAGE_SEC:
                break
        end = lines[j][0] if j < len(lines) else lines[j - 1][0] + LINE_WINDOW_SEC
        text = " ".join(t for _, t in lines[i:j])
        passages.append(Passage(len(passages), start, end, text))
        if j >= len(lines):
            break
        # Next passage starts OVERLAP_SEC before this one ended, but always moves on.
        nxt = j
        while (
            nxt - 1 > i
            and lines[nxt - 1][0] >= end - OVERLAP_SEC
            and lines[nxt - 1][0] > start
        ):
            nxt -= 1
        i = nxt
    return passages


def metadata_text(title: str | None, description: str | None) -> str:
    parts = [
        p for p in (title or "", (description or "")[:_META_DESCRIPTION_CHARS]) if p
    ]
    return "\n".join(parts).strip()
