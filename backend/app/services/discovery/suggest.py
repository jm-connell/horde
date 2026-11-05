"""Channels to follow: the new channels the Recommended feed liked most.

A channel qualifies with at least ``MIN_SUPPORT`` of its videos in the feed's
"new" bucket above the floor; it ranks by its best three videos (the best counts
most) plus a little for each distinct watch that led to it, so a channel several
interests point at beats a one-off.

Each suggestion carries up to ``MAX_TAGS`` short tags saying what the channel is
about: the AI categories its picked videos fall in (most first), then the
YouTube searches that found them.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from statistics import median

from .candidates import Candidate
from .feed import Feed, _short
from .feedback import Exclusions

MAX_SUGGESTIONS = 8
MAX_TAGS = 2
#: A search used as a tag is cut to this many words.
TAG_WORDS = 3
MIN_SUPPORT = 2
SAMPLES = 3


@dataclass
class Suggestion:
    name: str
    url: str
    score: float
    reason: str | None
    videos: list[Candidate]
    indexed: bool
    #: What a typical video of the channel the feed picked is like, when known.
    typical_views: int | None = None
    typical_minutes: int | None = None
    tags: list[str] = field(default_factory=list)


def _tags(
    keys: list[str], queries: Counter[str], categories: dict[str, set[str]]
) -> list[str]:
    """Up to ``MAX_TAGS``: the categories most of ``keys`` are in, then searches."""
    by_category = Counter(
        {name: len(members.intersection(keys)) for name, members in categories.items()}
    )
    out = [name for name, n in by_category.most_common() if n > 0][:MAX_TAGS]
    for query, _n in queries.most_common():
        if len(out) >= MAX_TAGS:
            break
        tag = " ".join(query.split()[:TAG_WORDS])
        if tag and tag.casefold() not in {t.casefold() for t in out}:
            out.append(tag)
    return out


def _typical(values: list[float]) -> float | None:
    return median(values) if values else None


def suggestions(
    feed: Feed,
    excluded: Exclusions,
    categories: dict[str, set[str]] | None = None,
) -> list[Suggestion]:
    """The best channels to follow; ``categories``: each AI category's picks."""
    out: list[Suggestion] = []
    for stat in feed.new_channels.values():
        if not stat.url or len(stat.items) < MIN_SUPPORT:
            continue
        if excluded.blocks_channel(stat.url, stat.name) or excluded.dismissed(
            stat.url, stat.name
        ):
            continue
        ranked = sorted(
            zip(stat.scores, stat.items, strict=True), key=lambda pair: -pair[0]
        )
        top = [score for score, _ in ranked[:3]]
        weights = (1.0, 0.5, 0.25)
        score = sum(w * s for w, s in zip(weights, top, strict=False))
        score += 0.03 * min(len(stat.seeds), 3)
        seed = sorted(stat.seeds)[0] if stat.seeds and not feed.cold else None
        views = _typical([c.view_count for c in stat.items if c.view_count])
        seconds = _typical([c.duration for c in stat.items if c.duration])
        out.append(
            Suggestion(
                name=stat.name or stat.url,
                url=stat.url,
                score=score,
                reason=f"Like {_short(seed, 50)}" if seed else None,
                videos=[c for _, c in ranked[:SAMPLES]],
                indexed=any(c.pool == "catalog" for c in stat.items),
                typical_views=round(views) if views is not None else None,
                typical_minutes=max(1, round(seconds / 60))
                if seconds is not None
                else None,
                tags=_tags([c.key for c in stat.items], stat.queries, categories or {}),
            )
        )
    out.sort(key=lambda s: -s.score)
    return out[:MAX_SUGGESTIONS]
