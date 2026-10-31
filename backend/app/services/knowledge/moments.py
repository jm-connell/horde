"""The exact moment within a passage that a search hit or a reference points to.

Passages span about 75 seconds; linking to their start would land up to a minute
early. Each video keeps its captions as short timed lines (``KbVideo.cues``), so
the moment is the line that shares the most words with what is being pointed at
(the search terms, or the sentence that cites the passage), opened a little early
so the sentence is heard from its start.
"""

from __future__ import annotations

import re

from .chunking import Line
from .search import STOPWORDS

LEAD_IN_SEC = 2.0
_WORD = re.compile(r"[^\W_]+", re.UNICODE)


def words(text: str) -> set[str]:
    """Meaningful words of ``text``, lower case, without stop words."""
    return {
        w
        for w in (t.casefold() for t in _WORD.findall(text or ""))
        if len(w) > 1 and w not in STOPWORDS
    }


def _match_count(line_words: set[str], wanted: set[str]) -> int:
    count = 0
    for w in wanted:
        if w in line_words or (
            len(w) >= 4 and any(lw.startswith(w) for lw in line_words)
        ):
            count += 1
    return count


def best_line(
    lines: list[Line], start: float, end: float, wanted: set[str]
) -> Line | None:
    """The line in ``[start, end)`` sharing the most of ``wanted``; None when none does."""
    found: Line | None = None
    best = 0
    for at, text in lines:
        if at < start - 0.01 or at >= end:
            continue
        score = _match_count(words(text), wanted)
        if score > best:
            best, found = score, (at, text)
    return found


def moment(lines: list[Line], start: float, end: float, wanted: set[str]) -> float:
    """Seconds to open at: just before the best-matching line, else ``start``."""
    line = best_line(lines, start, end, wanted)
    if line is None:
        return start
    return max(start, line[0] - LEAD_IN_SEC)
