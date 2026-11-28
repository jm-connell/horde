"""The site-wide AI categories (Settings -> AI) each of the feed's picks is in.

Only the tags on suggested channels read this (``suggest``); the category chips
of Recommended are the user's own interests (``category_feed``).

A pick belongs to a category by the same rule as a library video
(``recommend.category_members``), measured on its own embedding: library
videos, listed channels' uploads and videos found on YouTube alike. Picks
without an embedding belong to none. The result is kept on the cached ``Feed``
with the version of the categories it was measured against.
"""

from __future__ import annotations

import numpy as np
from sqlmodel import Session, select

from ...models import AiCategory
from ..ai import recommend
from .picks import Feed
from .relevance import candidate_sims
from .runtime import DiscoveryRuntime


def _version(session: Session) -> object:
    """What category membership depends on besides the feed itself."""
    rows = session.exec(select(AiCategory.name, AiCategory.updated_at)).all()
    return (tuple(sorted((n, str(u)) for n, u in rows)), recommend.category_min_score())


def feed_categories(
    session: Session, runtime: DiscoveryRuntime, feed: Feed
) -> dict[str, set[str]]:
    """Each category with picks in ``feed``: the keys of those picks."""
    version = _version(session)
    if feed.categories is not None and feed.categories[0] == version:
        return feed.categories[1]
    out: dict[str, set[str]] = {}
    named = recommend.category_vectors(session)
    cands = [item.candidate for item in feed.items]
    if named and cands:
        raw = np.asarray([vec for _, vec in named], dtype=np.float32)
        norms = np.linalg.norm(raw, axis=1, keepdims=True)
        cats = (raw / np.maximum(norms, 1e-12)).astype(np.float32)
        sims = candidate_sims(session, runtime, cands, cats)
        rows = np.flatnonzero(~np.isnan(sims).any(axis=1))
        if rows.size:
            members = recommend.category_members(sims[rows])
            for (name, _vec), picked in zip(named, members, strict=True):
                if picked.size:
                    out[name] = {cands[rows[i]].key for i in picked}
    feed.categories = (version, out)
    return out
