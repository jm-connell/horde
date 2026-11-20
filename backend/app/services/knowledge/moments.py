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
# A reference's quote: about one line of the panel.
QUOTE_CHARS = 190
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
# Words of context kept before the first matching word when a line has no
# punctuation to cut at.
_LEAD_WORDS = 3
# Words taken from the line before when it carries part of the point.
_PREVIOUS_WORDS = 10
_WORD = re.compile(r"[^\W_]+", re.UNICODE)


def words(text: str) -> set[str]:
    """Meaningful words of ``text``, lower case, without stop words."""
    return {
        w
        for w in (t.casefold() for t in _WORD.findall(text or ""))
        # Numbers count however short: "0.7 to 1 g" is the point of a line.
        if (len(w) > 1 or w.isdigit()) and w not in STOPWORDS
    }


#: A number shared with what cites a line weighs this much more than a word:
#: the line that says "60,000 miles" is the one to open at.
_NUMBER_WEIGHT = 3


def _match_count(line_words: set[str], wanted: set[str]) -> int:
    count = 0
    for w in wanted:
        if w in line_words or (
            len(w) >= 4 and any(lw.startswith(w) for lw in line_words)
        ):
            count += _NUMBER_WEIGHT if w.isdigit() else 1
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


def _is_match(word: str, wanted: set[str]) -> bool:
    w = word.casefold()
    return w in wanted or any(len(x) >= 4 and w.startswith(x) for x in wanted)


def quote(lines: list[Line], line: Line, wanted: set[str]) -> str:
    """What is said at ``line`` about ``wanted``, short enough to read at a glance.

    A caption line is five seconds of speech: it opens with the end of the
    sentence before and stops mid-sentence. The quote starts at the sentence
    that shares the most words (numbers above all) with what cites it and runs
    on into the next line to finish the thought; in captions without
    punctuation it starts a few words before the first shared word. When it
    opens mid-thought and the line before shares words too, it starts in that
    line. It is cut to ``QUOTE_CHARS``, and "…" marks each end known to be cut.
    """
    whole = line[1].strip()
    if not re.search(r"[.!?,]", whole):
        # Captions without punctuation: nothing says where a sentence starts
        # or ends, so start just before the first shared word and stop with
        # the line.
        parts = whole.split()
        first = next(
            (
                i
                for i, part in enumerate(parts)
                if any(_is_match(w, wanted) for w in _WORD.findall(part))
            ),
            0,
        )
        start = max(0, first - _LEAD_WORDS)
        opens_mid_sentence = start > 0
        # Without punctuation, only a capital says a sentence starts here.
        mid_thought = start > 0 or not parts[start][:1].isupper()
        ends_mid_sentence = False
        text = " ".join(parts[start:])
    else:
        sentences = _SENTENCE.split(whole)
        best = max(
            range(len(sentences)),
            key=lambda i: (_match_count(words(sentences[i]), wanted), -i),
        )
        opens_mid_sentence = best == 0 and not whole[:1].isupper()
        mid_thought = opens_mid_sentence
        text = " ".join(sentences[best:])
        following = next((t for at, t in lines if at > line[0]), "")
        if not text.endswith((".", "!", "?")) and following:
            text = f"{text} {_SENTENCE.split(following.strip())[0]}"
        ends_mid_sentence = not text.endswith((".", "!", "?"))
    previous = next((t for at, t in reversed(lines) if at < line[0]), "").strip()
    if mid_thought and previous and _match_count(words(previous), wanted):
        # The line opens mid-thought and the one before carries part of the
        # point ("…per pound of body weight", the number said just before):
        # start with the end of that one.
        head = _SENTENCE.split(previous)[-1]
        if not re.search(r"[.!?,]", previous):
            head = " ".join(previous.split()[-_PREVIOUS_WORDS:])
        opens_mid_sentence = not head[:1].isupper()
        text = f"{head} {text}"
    if len(text) > QUOTE_CHARS:
        text = text[:QUOTE_CHARS].rsplit(" ", 1)[0].rstrip(",;:")
        ends_mid_sentence = True
    return (
        ("…" if opens_mid_sentence else "") + text + ("…" if ends_mid_sentence else "")
    )
