"""The other people on this server: what they watched stands in for a short
history, and what people with similar taste liked gets a small lift."""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime

from sqlmodel import Session, select

from ...models import UserVideoState
from .. import app_settings
from .history import Watch, watches
from .picks import name_key


def _household(session: Session, user_id: int) -> tuple[list[Watch], dict[int, float]]:
    """Other users' watches, and how alike each user's channels are to this one's."""
    others = session.exec(
        select(UserVideoState.user_id)
        .where(UserVideoState.user_id != user_id)
        .distinct()
    ).all()
    mine: dict[str, float] = defaultdict(float)
    for w in watches(session, user_id, limit=300):
        mine[name_key(w.channel)] += w.engagement
    pooled: list[Watch] = []
    similarity: dict[int, float] = {}
    for other in others:
        theirs = watches(session, other, limit=300, include_youtube=False)
        pooled.extend(theirs)
        counts: dict[str, float] = defaultdict(float)
        for w in theirs:
            counts[name_key(w.channel)] += w.engagement
        dot = sum(v * counts.get(k, 0.0) for k, v in mine.items())
        norm = math.sqrt(sum(v * v for v in mine.values())) * math.sqrt(
            sum(v * v for v in counts.values())
        )
        similarity[other] = dot / norm if norm else 0.0
    return pooled, similarity


def cowatched(session: Session, user_id: int) -> dict[int, float]:
    """Library videos people with similar taste here liked, scaled 0..1."""
    if not app_settings.load().get("discovery_household", True):
        return {}
    _pooled, similarity = _household(session, user_id)
    weights: dict[int, float] = defaultdict(float)
    for other, sim in similarity.items():
        if sim < 0.1:
            continue
        for w in watches(session, other, limit=300, include_youtube=False):
            if w.video_id is not None and w.engagement >= 0.7:
                weights[w.video_id] += sim * w.engagement
    top = max(weights.values(), default=0.0)
    return {k: v / top for k, v in weights.items()} if top else {}


def taste_history(
    session: Session, user_id: int, older_than: datetime | None = None
) -> tuple[list[Watch], bool]:
    """The user's watches, or (cold start) also what the household watched,
    when ``discovery_household`` allows it. ``older_than``: see ``watches``."""
    own = watches(session, user_id, older_than=older_than)
    if len(own) >= 3:
        return own, False
    if not app_settings.load().get("discovery_household", True):
        return own, True
    pooled, _sim = _household(session, user_id)
    if pooled:
        pooled.sort(key=lambda w: w.watched_at, reverse=True)
        return own + pooled[:100], True
    return own, True
