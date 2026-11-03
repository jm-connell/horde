"""Is one upload clearly the next part of another? Decided from titles alone.

Used to autoplay a channel's next upload after a video ends, which is only
wanted when that upload continues the same series ("Day 12" -> "Day 13", the
same series name before a number one up, or the same "GTA RP | ..." series
tag). Anything weaker returns ``None`` and the player falls back to a related
recommendation, so the rules are deliberately strict: a wrong guess plays an
unrelated video.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

#: Segment separators in titles: "Series | Episode", "Series: Episode", "[Tag]".
_SEPARATORS = re.compile(r"\s[|–—-]\s|\s*[|:–—]\s*|[\[\]()]")
_WORD = re.compile(r"[a-z0-9]+")
_NUMBER = re.compile(r"\d+")
_DECIMAL = re.compile(r"\d+\.\d+")
#: A series tag shared by more than this share of a channel's uploads is the
#: channel's format ("| xQc Reacts"), not a series.
MAX_TAG_SHARE = 0.4
#: Stems (the title with its numbers blanked) must overlap at least this much.
MIN_STEM_OVERLAP = 0.5
_FILLER = {"the", "a", "an", "of", "and", "in", "on", "to", "with", "ft", "feat"}
#: Words before an episode number that say what is counted, not which series.
_COUNTERS = {
    "part",
    "pt",
    "ep",
    "episode",
    "day",
    "chapter",
    "ch",
    "no",
    "vol",
    "volume",
}


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _stem_tokens(title: str) -> set[str]:
    return {w for w in _words(title) if not w.isdigit() and w not in _FILLER}


def _overlap(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _numbers(title: str) -> list[int]:
    return [int(n) for n in _NUMBER.findall(title) if len(n) <= 4]


def _sequential(prev: str, nxt: str) -> str | None:
    """'Part 3' -> 'Part 4': same stem, one number up by exactly one."""
    if _overlap(_stem_tokens(prev), _stem_tokens(nxt)) < MIN_STEM_OVERLAP:
        return None
    a, b = _numbers(prev), _numbers(nxt)
    if not a or len(a) != len(b):
        return None
    diffs = [(x, y) for x, y in zip(a, b, strict=True) if x != y]
    if len(diffs) == 1 and diffs[0][1] == diffs[0][0] + 1:
        return f"part {diffs[0][1]} follows part {diffs[0][0]}"
    return None


def _episodes(title: str) -> list[tuple[int, list[str]]]:
    """Numbers that end a title segment, each with its segment's words before it.

    A number with words after it in its segment ("Episode 4 of Arcane",
    "iPhone 15 Pro") does not count the series, nor does a decimal ("1.20")
    or a year.
    """
    out = []
    for raw in _SEPARATORS.split(_DECIMAL.sub(" ", title)):
        words = _words(raw)
        if words and words[-1].isdigit() and len(words[-1]) <= 3:
            out.append((int(words[-1]), words[:-1]))
    return out


def _shared_ending(a: list[str], b: list[str]) -> list[str]:
    n = 0
    while n < min(len(a), len(b)) and a[-1 - n] == b[-1 - n]:
        n += 1
    return a[len(a) - n :]


def numbered_next(
    prev: str, nxt: str, *, channel_name: str | None = None
) -> str | None:
    """Why ``nxt`` is clearly the next numbered part of ``prev``, or None.

    The same series name ends a segment of both titles with a number one up,
    whatever else the titles say ('City of Intersections | Cities: Skylines #2'
    -> 'Biggest Roundabout | Cities Skylines #3'). The name needs 2+ words or
    5+ letters, and naming the channel does not count. Strict enough to look
    past other uploads for.
    """
    channel = set(_words(channel_name or ""))
    for a, before_a in _episodes(prev):
        for b, before_b in _episodes(nxt):
            if b != a + 1:
                continue
            name = [
                w
                for w in _shared_ending(before_a, before_b)
                if w not in _COUNTERS and w not in _FILLER and not w.isdigit()
            ]
            if channel and channel <= set(name):
                continue
            if len(name) >= 2 or (name and len(name[0]) >= 5):
                return f"{' '.join(name)} {b} follows {a}"
    return None


def series_tags(title: str) -> set[str]:
    """Title segments that could name a series: 2+ words or 5+ letters, not the whole title."""
    whole = " ".join(_words(title))
    tags: set[str] = set()
    for raw in _SEPARATORS.split(title):
        seg = " ".join(_words(raw))
        if not seg or seg == whole or seg.isdigit():
            continue
        if len(seg.split()) >= 2 or len(seg) >= 5:
            tags.add(seg)
    return tags


def next_part_reason(
    prev_title: str,
    next_title: str,
    *,
    channel_name: str | None = None,
    channel_titles: Iterable[str] = (),
) -> str | None:
    """Why ``next_title`` continues ``prev_title``, or None when it is not clear.

    ``channel_titles`` are other recent uploads of the channel, to tell a
    series tag from a tag the channel puts on everything.
    """
    if not prev_title or not next_title:
        return None
    if " ".join(_words(prev_title)) == " ".join(_words(next_title)):
        return None
    reason = _sequential(prev_title, next_title) or numbered_next(
        prev_title, next_title, channel_name=channel_name
    )
    if reason:
        return reason
    channel = set(_words(channel_name or ""))
    # A tag that is (or contains) the channel's name says who, not what.
    shared = {
        tag
        for tag in series_tags(prev_title) & series_tags(next_title)
        if not (channel and channel <= set(tag.split()))
    }
    if not shared:
        return None
    others = [t for t in channel_titles if t]
    for tag in sorted(shared, key=len, reverse=True):
        if others:
            share = sum(tag in series_tags(t) for t in others) / len(others)
            if share > MAX_TAG_SHARE:
                continue
        return f"same series: {tag}"
    return None
