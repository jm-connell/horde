"""A user's interests, kept as the category chips of Recommended.

``interests.interests`` groups a person's watches afresh each time, so its
groups have no identity: the same interest comes back with a slightly different
centre and, from a chat model, maybe another name. ``sync`` files the groups
under stored rows (``rec_categories``) instead: a group close to a row's centre
is that row, which keeps its id and name and takes the group's new centre,
weight, searches and seeds. A chip therefore stays put while the history moves.

Each row also learns how much a video's age counts in it (``half_life``), from
how old the videos in the group were when the user watched them.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta

import numpy as np
from sqlmodel import Session, col, select

from ...models import (
    ChannelCatalogVideo,
    DiscoveryVideo,
    RecCategory,
    Video,
    as_utc,
    utcnow,
)
from ..ai import embeddings
from . import tuning
from .candidates import parse_published
from .feedback import exclusions
from .history import Watch, counts_as_taste, watches
from .interests import (
    DORMANT_SIMILARITY,
    Interest,
    interests,
    keyword_queries,
    llm_queries,
)
from .runtime import DiscoveryRuntime

logger = logging.getLogger(__name__)

#: A row no group has matched for this long is deleted.
FORGET_AFTER = timedelta(days=14)
#: ``ensure`` leaves rows alone that were brought up to date this recently.
FRESH_FOR = timedelta(hours=6)
#: Watches with a known upload date a category needs before age counts in it.
MIN_AGES = 5
MIN_HALF_LIFE_DAYS = 90.0
#: A half-life longer than this says age does not matter here.
MAX_HALF_LIFE_DAYS = 5 * 365.0
#: Watches kept per category whose up next lists a top-up may read.
MAX_SEEDS = 10


def half_life(ages_days: list[float]) -> float | None:
    """How many days halve a video's standing in a category, from how old its
    watched videos were when watched; None when age should not count.

    Twice the 75th percentile: someone who watches this month's uploads gets a
    short one (old videos sink), someone who has been watching years-old videos
    a long one or none (they stay).
    """
    if len(ages_days) < MIN_AGES:
        return None
    value = 2.0 * float(np.percentile(np.asarray(ages_days, dtype=np.float64), 75))
    if value > MAX_HALF_LIFE_DAYS:
        return None
    return max(MIN_HALF_LIFE_DAYS, value)


def _published(session: Session, group: list[Watch]) -> dict[str, datetime]:
    """When each watch's video was uploaded, where Horde knows (by watch key)."""
    out: dict[str, datetime] = {}
    by_video = {w.video_id: w.key for w in group if w.video_id is not None}
    if by_video:
        for vid, published in session.exec(
            select(Video.id, Video.published_at).where(
                col(Video.id).in_(list(by_video))
            )
        ).all():
            uploaded = parse_published(published)
            if vid is not None and uploaded is not None:
                out[by_video[vid]] = uploaded
    by_yt = {w.yt_id: w.key for w in group if w.yt_id and w.key not in out}
    if by_yt:
        for model in (DiscoveryVideo, ChannelCatalogVideo):
            for yt_id, raw in session.exec(
                select(model.yt_id, model.published_at).where(
                    col(model.yt_id).in_(list(by_yt))
                )
            ).all():
                when = parse_published(raw)
                if when is not None:
                    out.setdefault(by_yt[yt_id], when)
    return out


def _half_life_of(session: Session, group: Interest) -> float | None:
    published = _published(session, group.watches)
    ages = [
        max(0.0, (w.watched_at - published[w.key]).total_seconds() / 86400)
        for w in group.watches
        if w.key in published
    ]
    return half_life(ages)


def centre(row: RecCategory) -> np.ndarray:
    return np.asarray(embeddings.unpack_vector(row.centroid, row.dim), dtype=np.float32)


def queries(row: RecCategory) -> list[str]:
    try:
        data = json.loads(row.queries_json or "[]")
    except ValueError:
        return []
    return [str(q) for q in data] if isinstance(data, list) else []


def seeds(row: RecCategory) -> list[tuple[str, str]]:
    """(YouTube id, title) of the watches whose up next lists a top-up reads."""
    try:
        data = json.loads(row.seeds_json or "[]")
    except ValueError:
        return []
    if not isinstance(data, list):
        return []
    return [
        (str(pair[0]), str(pair[1]))
        for pair in data
        if isinstance(pair, list) and len(pair) == 2
    ]


def rows(session: Session, user_id: int) -> list[RecCategory]:
    """The user's categories: what they are into now first, heaviest first."""
    found = session.exec(
        select(RecCategory).where(RecCategory.user_id == user_id)
    ).all()
    return sorted(found, key=lambda r: (r.era != "recent", -r.weight, r.id or 0))


def sync(
    session: Session,
    user_id: int,
    groups: list[Interest],
    now: datetime,
    *,
    keep_searches: bool = False,
) -> list[RecCategory]:
    """Bring the user's rows in step with ``groups``; returns their rows.

    ``keep_searches``: a row that has searches keeps them (the groups' were
    made without a chat model, the row's maybe with one).
    """
    named = [g for g in groups if g.centroid is not None]
    dims = {int(g.centroid.shape[0]) for g in named if g.centroid is not None}
    stored = rows(session, user_id)
    for row in stored:
        # Another embed model's vectors cannot be compared with these.
        if dims and row.dim not in dims:
            session.delete(row)
    stored = [r for r in stored if not dims or r.dim in dims]
    free = {r.id: r for r in stored}
    taken: list[np.ndarray] = []
    for g in named:
        assert g.centroid is not None  # noqa: S101 - filtered above
        match: RecCategory | None = None
        best = DORMANT_SIMILARITY
        for row in free.values():
            sim = float(centre(row) @ g.centroid)
            if sim >= best:
                match, best = row, sim
        if match is None and g.name:
            # The same name is the same chip, however far the centre moved.
            match = next(
                (r for r in free.values() if r.name.casefold() == g.name.casefold()),
                None,
            )
        if match is None:
            if not g.name:
                continue
            match = RecCategory(user_id=user_id, name=g.name, named_by=g.named_by)
        else:
            free.pop(match.id, None)
            # A chat model's name replaces one made from title words, once.
            if g.name and g.named_by == "llm" and match.named_by != "llm":
                match.name, match.named_by = g.name, "llm"
        match.era = g.era
        match.centroid = embeddings.pack_vector(g.centroid.tolist())
        match.dim = int(g.centroid.shape[0])
        match.weight = g.weight
        match.half_life_days = _half_life_of(session, g)
        if g.queries and not (keep_searches and queries(match)):
            match.queries_json = json.dumps(g.queries)
        match.seeds_json = json.dumps(
            [[w.yt_id, w.title] for w in g.watches if w.yt_id and w.engagement >= 0.7][
                :MAX_SEEDS
            ]
        )
        match.seen_at = now
        match.updated_at = now
        session.add(match)
        taken.append(g.centroid)
    for row in free.values():
        # A second row for an interest that has one (two refreshes at once
        # each made it), or an interest long gone.
        twin = any(float(centre(row) @ c) >= DORMANT_SIMILARITY for c in taken)
        if twin or now - as_utc(row.seen_at) > FORGET_AFTER:
            session.delete(row)
        else:
            # Still listed, and not looked at again until the next refresh.
            row.updated_at = now
            session.add(row)
    session.commit()
    return rows(session, user_id)


def groups_for(
    session: Session,
    runtime: DiscoveryRuntime,
    user_id: int,
    now: datetime,
    *,
    use_llm: bool,
) -> tuple[list[Interest], list[Interest], list[Watch]]:
    """(recent, dormant) interest groups with names and searches, and the
    history they were made from."""
    tuned = tuning.for_user(session, user_id)
    left_out = exclusions(session, user_id).taste
    history = [
        w
        for w in watches(
            session,
            user_id,
            older_than=now - timedelta(days=tuned.window.throwback_after_days),
        )
        if counts_as_taste(w, tuned.min_watched_pct) and w.key not in left_out
    ]
    recent, dormant = interests(session, runtime, history, now, tuned.window)
    groups = recent + dormant
    if use_llm:
        llm_queries(groups)
    # Whatever the chat model left out (or all of it, without one).
    keyword_queries(session, groups, history)
    return recent, dormant, history


def ensure(
    session: Session,
    runtime: DiscoveryRuntime,
    user_id: int,
    now: datetime | None = None,
) -> None:
    """Make sure the user's categories are recent, without a chat model (a
    request may call this; the gatherer names them with one where it may)."""
    now = now or utcnow()
    latest = session.exec(
        select(RecCategory.updated_at)
        .where(RecCategory.user_id == user_id)
        .order_by(col(RecCategory.updated_at).desc())
        .limit(1)
    ).first()
    if latest is not None and now - as_utc(latest) < FRESH_FOR:
        return
    # Someone with no categories (no embeddings, little watched) has no row to
    # say they were looked at: remember it here, or every visit would look.
    if latest is None and not runtime.categories_due(
        user_id, FRESH_FOR.total_seconds()
    ):
        return
    recent, dormant, _history = groups_for(
        session, runtime, user_id, now, use_llm=False
    )
    sync(session, user_id, recent + dormant, now, keep_searches=True)
