"""How well a candidate fits a user's taste.

With embeddings: its closeness to the user's recent and older watches and to
the centres of their interests, on a scale embed models agree on
(``_calibrated``). Without: the watched channels and tags it shares. Also
which channels the user watches now, knows, and used to watch.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np
from sqlmodel import Session, col, select

from ...models import VideoTag
from .. import app_settings
from ..ai import vector_index
from ..ai.provider import get_embed_provider
from .candidates import Candidate
from .history import Watch
from .interests import (
    DEFAULT_WINDOW,
    RECENT_HALF_LIFE_DAYS,
    Interest,
    TasteWindow,
    interests,
    split_history,
    watch_vectors,
    watch_weight,
)
from .picks import name_key
from .runtime import DiscoveryRuntime

#: Seeds read from the recent history (by weight).
MAX_SEEDS = 40


def _scaled(weights: dict[str, float]) -> dict[str, float]:
    top = max(weights.values(), default=0.0)
    return {k: v / top for k, v in weights.items()} if top > 0 else {}


def channel_maps(
    history: list[Watch], now: datetime, window: TasteWindow = DEFAULT_WINDOW
) -> tuple[dict[str, float], dict[str, float], dict[str, float]]:
    """(recent, all-time, long-ago) channel strengths by lowercased name, 0..1.

    ``history`` is the whole watch log (``watch_log``), not the part read for
    taste: which channels the user knows, and used to watch, must not depend
    on how much they watched since.
    """
    recent, _sample = split_history(history, now, window)
    taken = {w.key for w in recent}
    newest = now - timedelta(days=window.throwback_after_days)
    oldest = now - timedelta(days=window.throwback_max_days)
    older = [
        w for w in history if w.key not in taken and oldest <= w.watched_at <= newest
    ]
    recent_w: dict[str, float] = defaultdict(float)
    for w in recent:
        recent_w[name_key(w.channel)] += watch_weight(w, now, RECENT_HALF_LIFE_DAYS)
    all_w: dict[str, float] = defaultdict(float)
    for w in history:
        all_w[name_key(w.channel)] += watch_weight(w, now, 120.0)
    old_w: dict[str, float] = defaultdict(float)
    for w in older:
        old_w[name_key(w.channel)] += w.engagement
    for maps in (recent_w, all_w, old_w):
        maps.pop("", None)
    return _scaled(recent_w), _scaled(all_w), _scaled(old_w)


def _fit(sims: np.ndarray, w: np.ndarray, centre_sims: np.ndarray) -> np.ndarray:
    """How well each row fits an interest: its closest watch and closest group.

    The closest single watch catches a series or a very specific topic; the
    closest group centre (``interests``) is steadier. How *much* of each interest
    the feed shows is the mixer's job (``mix``), so a small interest's videos fit
    as well as a big one's. A watch counts a little less when it is old or was
    half watched (``w``). Rows without a vector (all NaN) stay NaN.
    """
    best = np.max(np.nan_to_num(sims * (0.85 + 0.15 * w), nan=-np.inf), axis=1)
    usable = ~np.all(np.isnan(sims), axis=1)
    if centre_sims.shape[1]:
        centre = np.max(np.nan_to_num(centre_sims, nan=-np.inf), axis=1)
        fit = 0.6 * best + 0.4 * centre
    else:
        fit = best
    out: np.ndarray = np.where(usable, fit, np.nan)
    return out


def _calibrated(
    raw: np.ndarray, seeds: np.ndarray, w: np.ndarray, centres: np.ndarray
) -> np.ndarray:
    """Fit on a scale embed models agree on: 1 is "as close as the user's own
    watches are to each other", 0 is the bottom tenth of all candidates.

    Cosines differ a lot between models (some put unrelated text at 0.5), and a
    pool can be mostly relevant (found videos all are), so neither a fixed
    cut-off nor a percentile of the pool works on its own.
    """
    finite = raw[np.isfinite(raw)]
    if finite.size == 0:
        return np.zeros_like(raw)
    lo = float(np.percentile(finite, 10))
    hi = float("nan")
    if len(seeds) >= 3:
        among = seeds @ seeds.T
        np.fill_diagonal(among, np.nan)
        hi = float(np.nanmedian(_fit(among, w, seeds @ centres.T)))
    if not math.isfinite(hi) or hi <= lo:
        hi = float(np.percentile(finite, 99))
    span = max(hi - lo, 0.02)
    out: np.ndarray = np.where(
        np.isfinite(raw), np.clip((raw - lo) / span, 0.0, 1.25), 0.0
    )
    return out


@dataclass
class Similarity:
    """Per candidate: fit to recent and to dormant interests, and why."""

    recent: np.ndarray
    recent_raw: np.ndarray
    recent_seed: list[str | None]
    dormant: np.ndarray
    dormant_seed: list[str | None]
    #: The recent interest (``interests``) each candidate fits best, and each
    #: interest's share of the recent history.
    topic: list[int | None]
    topic_shares: dict[int, float]


def _seed_matrix(
    picked: list[Watch], weights: list[float], vectors: dict[str, np.ndarray]
) -> tuple[np.ndarray, np.ndarray, list[Watch]]:
    rows = [(w, wt) for w, wt in zip(picked, weights, strict=True) if w.key in vectors]
    rows.sort(key=lambda r: -r[1])
    rows = rows[:MAX_SEEDS]
    if not rows:
        return np.zeros((0, 0), dtype=np.float32), np.zeros(0, dtype=np.float32), []
    matrix = np.asarray([vectors[w.key] for w, _ in rows], dtype=np.float32)
    w = np.asarray([wt for _, wt in rows], dtype=np.float32)
    return matrix, w / max(float(w.max()), 1e-6), [w for w, _ in rows]


class Vectors:
    """Where each candidate's vector is, looked up once for a ranking.

    A ranking scores the same candidates against several sets of seeds (recent
    and older watches, their group centres, topics): finding the vectors again
    for each was a query and a pass over every candidate per set.
    """

    def __init__(
        self, session: Session, runtime: DiscoveryRuntime, cands: list[Candidate]
    ) -> None:
        self._session = session
        self._count = len(cands)
        #: (row in the result, library video id) of the library candidates.
        self._library = [
            (i, c.video_id) for i, c in enumerate(cands) if c.video_id is not None
        ]
        self._store = runtime.vectors.matrix(session)
        index = self._store.index
        stored = [
            (i, index[c.yt_id])
            for i, c in enumerate(cands)
            if c.video_id is None and c.yt_id and c.yt_id in index
        ]
        self._stored_at = np.asarray([i for i, _row in stored], dtype=np.int64)
        self._stored_rows = np.asarray([row for _i, row in stored], dtype=np.int64)

    def sims(self, seeds: np.ndarray) -> np.ndarray:
        """(candidates, len(seeds)) cosines; NaN rows for candidates without a vector."""
        out = np.full((self._count, len(seeds)), np.nan, dtype=np.float32)
        if len(seeds) == 0:
            return out
        ids, scores = vector_index.video_scores(self._session, seeds.tolist())
        row_of = {int(v): i for i, v in enumerate(ids)}
        for i, video_id in self._library:
            row = row_of.get(video_id)
            if row is not None:
                out[i] = scores[row]
        if self._store.dim == seeds.shape[1] and self._stored_at.size:
            out[self._stored_at] = self._store.rows[self._stored_rows] @ seeds.T
        return out


def candidate_sims(
    session: Session,
    runtime: DiscoveryRuntime,
    cands: list[Candidate],
    seeds: np.ndarray,
) -> np.ndarray:
    """(len(cands), len(seeds)) cosines; NaN rows for candidates without a vector."""
    return Vectors(session, runtime, cands).sims(seeds)


@dataclass
class _Interests:
    """Seeds (watches) and group centres of one part of the history."""

    seeds: np.ndarray
    weights: np.ndarray
    watches: list[Watch]
    centres: np.ndarray
    shares: list[float]


def _interest_matrix(
    groups: list[Interest],
    vectors: dict[str, np.ndarray],
    weight: Callable[[Watch], float],
) -> _Interests:
    members = [w for g in groups for w in g.watches]
    seeds, w, seed_watches = _seed_matrix(
        members, [weight(x) for x in members], vectors
    )
    centred = [
        g
        for g in groups
        if g.centroid is not None and len(g.centroid) == seeds.shape[1]
    ]
    centres = (
        np.asarray([g.centroid for g in centred], dtype=np.float32)
        if centred
        else np.zeros((0, seeds.shape[1] if len(seeds) else 0), dtype=np.float32)
    )
    total = sum(g.weight for g in centred) or 1.0
    return _Interests(
        seeds, w, seed_watches, centres, [g.weight / total for g in centred]
    )


def similarity(
    session: Session,
    runtime: DiscoveryRuntime,
    cands: list[Candidate],
    vectors_of: Vectors,
    history: list[Watch],
    now: datetime,
    window: TasteWindow = DEFAULT_WINDOW,
) -> Similarity | None:
    """Embedding fit, or None without embeddings."""
    if get_embed_provider() is None or app_settings.ai_settings().get("paused"):
        return None
    recent_groups, dormant_groups = interests(session, runtime, history, now, window)
    recent, older = split_history(history, now, window)
    vectors = watch_vectors(session, runtime, recent + older)
    mine = _interest_matrix(
        recent_groups, vectors, lambda x: watch_weight(x, now, RECENT_HALF_LIFE_DAYS)
    )
    if len(mine.seeds) == 0:
        return None
    sims = vectors_of.sims(mine.seeds)
    centre_sims = vectors_of.sims(mine.centres)
    raw = _fit(sims, mine.weights, centre_sims)
    best_seed = np.argmax(np.nan_to_num(sims, nan=-np.inf), axis=1)
    best_centre = (
        np.argmax(np.nan_to_num(centre_sims, nan=-np.inf), axis=1)
        if len(mine.centres)
        else None
    )
    recent_seed: list[str | None] = []
    topic: list[int | None] = []
    for i in range(len(cands)):
        usable = bool(np.isfinite(raw[i]))
        recent_seed.append(mine.watches[int(best_seed[i])].title if usable else None)
        topic.append(
            int(best_centre[i]) if usable and best_centre is not None else None
        )

    old = _interest_matrix(dormant_groups, vectors, lambda x: x.engagement)
    dormant = np.zeros(len(cands), dtype=np.float32)
    dormant_seed: list[str | None] = [None] * len(cands)
    if len(old.seeds) and old.seeds.shape[1] == mine.seeds.shape[1]:
        old_sims = vectors_of.sims(old.seeds)
        old_centres = vectors_of.sims(old.centres)
        dormant = _calibrated(
            _fit(old_sims, old.weights, old_centres),
            old.seeds,
            old.weights,
            old.centres,
        )
        idx = np.argmax(np.nan_to_num(old_sims, nan=-np.inf), axis=1)
        dormant_seed = [
            None if np.all(np.isnan(old_sims[i])) else old.watches[int(idx[i])].title
            for i in range(len(cands))
        ]
    return Similarity(
        recent=_calibrated(raw, mine.seeds, mine.weights, mine.centres),
        recent_raw=raw,
        recent_seed=recent_seed,
        dormant=dormant,
        dormant_seed=dormant_seed,
        topic=topic,
        topic_shares=dict(enumerate(mine.shares)),
    )


def taste_relevance(
    session: Session,
    cands: list[Candidate],
    history: list[Watch],
    all_channels: dict[str, float],
) -> np.ndarray:
    """Without AI: the watched channels and tags a candidate shares, 0..1."""
    rank_of = {w.video_id: r for r, w in enumerate(history[:200]) if w.video_id}
    engagement = {w.video_id: w.engagement for w in history if w.video_id}
    tag_w: dict[str, float] = defaultdict(float)
    if rank_of:
        for vid, tag in session.exec(
            select(VideoTag.video_id, VideoTag.tag).where(
                col(VideoTag.video_id).in_(list(rank_of))
            )
        ).all():
            tag_w[tag.lower()] += 0.97 ** rank_of[vid] * engagement[vid]
    tags = _scaled(tag_w)
    out = np.zeros(len(cands), dtype=np.float32)
    for i, c in enumerate(cands):
        best = sorted((tags.get(t, 0.0) for t in c.tags), reverse=True)[:3]
        out[i] = 0.6 * all_channels.get(name_key(c.channel), 0.0) + 0.4 * sum(best) / 3
    return out
