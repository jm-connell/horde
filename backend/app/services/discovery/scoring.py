"""What each kind of pick is scored on: one recipe per kind.

A pick's score is the sum of its recipe's terms (a weight times a signal),
then the popularity lean, then what the user's settings add (downloaded,
shuffle) and take away (shown before). "Why this?" lists the same terms, so a
weight changed here is the weight the user is shown. Which kind a candidate is,
and why it is there, is decided in ``feed.build_feed``.

Scores are compared inside a bucket only (``mix`` takes from each bucket in
turn), so the weights of one recipe say nothing about another's.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime

from .tuning import Tuning

#: A channel this strong in the recent history counts like a followed one.
WATCHED_CHANNEL_LEVEL = 0.25
#: A channel this strong long ago, and absent lately, is a throwback channel.
DORMANT_CHANNEL_LEVEL = 0.3
#: A followed channel counts at least this much as "watched lately".
FOLLOWED_CHANNEL_LEVEL = 0.6
#: An older interest must fit this much better than recent taste to make a
#: pick a throwback rather than a similar or new one.
THROWBACK_LEAD = 0.15
#: Below these a pick waits at the end of the feed instead of in its bucket.
#: With embeddings, relevance is calibrated (``relevance._calibrated``): 1 is
#: as close as the user's own recent watches are to each other. New channels
#: must be clearly relevant; known ones may be a little less.
FLOORS = {"similar": 0.45, "new": 0.6, "throwback": 0.55}
#: Without embeddings relevance is the channel and tag taste (0..1).
TASTE_FLOORS = {"similar": 0.15, "new": 0.3, "throwback": 0.3}
#: A video found on YouTube but not embedded yet stands on its source's own
#: ranking: this far above the "new" floor for the first result, a tenth less
#: of it for each place after.
UNEMBEDDED_HIT_LIFT = 0.3
UNEMBEDDED_HIT_DECAY = 0.9
#: A similar pick people here liked this much qualifies whatever its fit.
COWATCH_QUALIFIES = 0.5
#: The seeded shuffle (standard deviation of the score), larger for new channels.
JITTER = 0.02
NEW_JITTER = 0.06

#: The signal that is computed from the upload date and the recipe's half-life.
FRESH = "fresh"


@dataclass(frozen=True)
class Term:
    #: What "Why this?" calls it.
    label: str
    weight: float
    #: The signal it weighs: a key of the signals given to ``Scorer.parts``, or ``FRESH``.
    signal: str


@dataclass(frozen=True)
class Recipe:
    terms: tuple[Term, ...]
    #: The upload age, in days, at which ``FRESH`` halves (before the user's
    #: freshness setting scales it).
    half_life_days: float = 0.0
    #: The kind's own lean toward popular videos, to which the user's lean is
    #: added; None when views play no part.
    popularity: float | None = None


#: Signals are 0..1, except "taste" (calibrated relevance, up to 1.25):
#:   taste           fit to the user's recent taste
#:   taste_capped    the same, at most 1
#:   known           how much the user has watched the channel, ever
#:   channel_now     how much they watch it lately (a followed one counts too)
#:   long_ago        how much they watched it before the throwback line
#:   older           fit to an interest they have not touched lately
#:   older_or_taste  the better of ``older`` and ``taste``
#:   interest        fit to an interest they typed in
#:   rewatched       1 when they watched it more than once
#:   time_away       how long since they watched it (1 at a year)
#:   cowatch         how much people here with similar taste liked it
RECIPES: dict[str, Recipe] = {
    "rewatch": Recipe(
        (
            Term("Match to your taste", 0.45, "taste_capped"),
            Term("A channel you watch", 0.25, "known"),
            Term("Watched more than once", 0.15, "rewatched"),
            Term("Time since you watched it", 0.15, "time_away"),
        )
    ),
    "subscriptions": Recipe(
        (
            Term("Freshness", 0.55, FRESH),
            Term("A channel you watch lately", 0.25, "channel_now"),
            Term("Match to your taste", 0.20, "taste_capped"),
        ),
        half_life_days=10.0,
        popularity=0.0,
    ),
    "interest": Recipe(
        (
            Term("Match to your interest", 0.6, "interest"),
            Term("Match to your taste", 0.2, "taste_capped"),
            Term("Freshness", 0.1, FRESH),
        ),
        half_life_days=90.0,
        popularity=0.06,
    ),
    # A channel the user used to watch and stopped.
    "throwback_channel": Recipe(
        (
            Term("How much you used to watch this channel", 0.45, "long_ago"),
            Term("Match to an older interest", 0.35, "older"),
            Term("Freshness", 0.2, FRESH),
        ),
        half_life_days=180.0,
        popularity=0.0,
    ),
    # Close to an interest the user has not touched lately.
    "throwback_interest": Recipe(
        (
            Term("Match to an older interest", 0.7, "older_or_taste"),
            Term("Freshness", 0.15, FRESH),
        ),
        half_life_days=365.0,
        popularity=0.15,
    ),
    "new": Recipe(
        (
            Term("Match to your taste", 1.0, "taste"),
            Term("Freshness", 0.05, FRESH),
        ),
        half_life_days=90.0,
        popularity=0.08,
    ),
    "similar": Recipe(
        (
            Term("Match to your taste", 1.0, "taste"),
            Term("A channel you watch", 0.08, "known"),
            Term("Freshness", 0.04, FRESH),
            Term("Liked by people here", 0.1, "cowatch"),
        ),
        half_life_days=60.0,
        popularity=0.04,
    ),
}


def fresh(when: datetime | None, now: datetime, half_life_days: float) -> float:
    if when is None:
        return 0.0
    days = max(0.0, (now - when).total_seconds() / 86400)
    return float(0.5 ** (days / half_life_days))


def quality(views: int | None) -> float:
    """A popularity prior: 1k views or fewer 0, a few million 1; unknown 0.5."""
    if views is None:
        return 0.5
    return float(min(1.0, max(0.0, (math.log10(views + 1) - 3.0) / 3.5)))


def unembedded_hit(floor: float, rank: int) -> float:
    """The relevance a found video without a vector gets from its place in
    the search or up next list that found it (``floor``: the "new" floor)."""
    return floor + UNEMBEDDED_HIT_LIFT * UNEMBEDDED_HIT_DECAY**rank


class Scorer:
    """The recipes with one user's settings applied, for one ranking."""

    def __init__(self, tuning: Tuning, now: datetime) -> None:
        self._now = now
        scale = tuning.half_life_scale
        #: Each recipe's freshness half-life as this user set it.
        self._half_life = {
            kind: recipe.half_life_days * scale for kind, recipe in RECIPES.items()
        }
        #: The user's lean toward popular videos (positive) or hidden gems
        #: (negative), added to each recipe's own; an unknown view count is neutral.
        self._lean = tuning.popularity_delta

    def parts(
        self,
        kind: str,
        signals: Mapping[str, float],
        published: datetime | None,
        views: float,
        labels: Mapping[str, str] | None = None,
    ) -> list[tuple[str, float]]:
        """The terms of the recipe ``kind`` for one candidate, as (label,
        score) in the recipe's order.

        ``views`` is the candidate's ``quality``; ``labels`` renames a term by
        its signal where the text depends on the candidate.
        """
        recipe = RECIPES[kind]
        out: list[tuple[str, float]] = []
        for term in recipe.terms:
            value = (
                fresh(published, self._now, self._half_life[kind])
                if term.signal == FRESH
                else signals[term.signal]
            )
            label = labels.get(term.signal, term.label) if labels else term.label
            out.append((label, term.weight * value))
        if recipe.popularity is not None:
            out.append(
                ("Popularity", recipe.popularity * views + self._lean * (2 * views - 1))
            )
        return out
