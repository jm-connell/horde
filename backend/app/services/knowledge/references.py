"""Turn the model's ``[n]`` excerpt citations into a numbered reference list.

The model cites excerpt numbers only; it never writes a time. Here each citation
is checked (numbers the model was not given are dropped), resolved to the exact
caption line its sentence talks about (``moments``), and renumbered in order of
first use, so the answer reads "… [1] … [2]" with references 1, 2, … below it.
The same excerpt cited by sentences about different moments becomes two
references, each opening where its point is made.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import asdict, dataclass

from . import moments
from .chunking import Line
from .retrieval import Excerpt

_CITE = re.compile(r"\s?\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]")
_SENTENCE_END = re.compile(r"[.!?…](?=\s)|\n")


@dataclass
class Reference:
    n: int
    channel_id: int
    channel: str
    title: str
    yt_id: str
    published_at: str | None
    start_sec: float
    library_video_id: int | None
    #: The caption line the reference opens at ("" for a description).
    line: str
    is_description: bool

    def as_dict(self) -> dict:
        return asdict(self)


def _sentence_before(text: str, end: int) -> str:
    starts = [m.end() for m in _SENTENCE_END.finditer(text, 0, end)]
    return text[starts[-1] if starts else 0 : end]


def resolve(
    reply: str,
    excerpts: list[Excerpt],
    lines_of: Callable[[int], list[Line]],
) -> tuple[str, list[Reference]]:
    """The reply with renumbered markers, and its references in order."""
    by_n = {e.n: e for e in excerpts}
    refs: dict[tuple[int, int], Reference] = {}

    def replace(match: re.Match[str]) -> str:
        sentence = _CITE.sub("", _sentence_before(reply, match.start()))
        wanted = moments.words(sentence)
        numbers: list[int] = []
        for raw in re.split(r"[,;]", match.group(1)):
            excerpt = by_n.get(int(raw))
            if excerpt is None:
                continue
            line: Line | None = None
            start = excerpt.start_sec
            if not excerpt.is_description:
                line = moments.best_line(
                    lines_of(excerpt.kb_video_id),
                    excerpt.start_sec,
                    excerpt.end_sec,
                    wanted,
                )
                if line is not None:
                    start = max(excerpt.start_sec, line[0] - moments.LEAD_IN_SEC)
            key = (excerpt.chunk_id, int(start))
            ref = refs.get(key)
            if ref is None:
                ref = Reference(
                    n=len(refs) + 1,
                    channel_id=excerpt.channel_id,
                    channel=excerpt.channel_name,
                    title=excerpt.title,
                    yt_id=excerpt.yt_id,
                    published_at=excerpt.published_at,
                    start_sec=start,
                    library_video_id=excerpt.library_video_id,
                    line=line[1] if line else "",
                    is_description=excerpt.is_description,
                )
                refs[key] = ref
            if ref.n not in numbers:
                numbers.append(ref.n)
        return "".join(f"[{n}]" for n in numbers)

    content = _CITE.sub(replace, reply)
    return content.strip(), sorted(refs.values(), key=lambda r: r.n)
