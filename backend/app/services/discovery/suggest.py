"""Channels to follow: the new channels the Recommended+ feed liked most.

A channel qualifies with at least ``MIN_SUPPORT`` of its videos in the feed's
"new" bucket above the floor; it ranks by its best three videos (the best counts
most) plus a little for each distinct watch that led to it, so a channel several
interests point at beats a one-off.
"""

from __future__ import annotations

from dataclasses import dataclass

from .candidates import Candidate
from .feed import Feed, _short
from .feedback import Exclusions

MAX_SUGGESTIONS = 8
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


def suggestions(feed: Feed, excluded: Exclusions) -> list[Suggestion]:
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
        out.append(
            Suggestion(
                name=stat.name or stat.url,
                url=stat.url,
                score=score,
                reason=f"Because you watched {_short(seed)}" if seed else None,
                videos=[c for _, c in ranked[:SAMPLES]],
                indexed=any(c.pool == "catalog" for c in stat.items),
            )
        )
    out.sort(key=lambda s: -s.score)
    return out[:MAX_SUGGESTIONS]
