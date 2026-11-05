"""The AI categories: which videos belong to each.

A video belongs to a category by its profile vector (metadata plus a share of
the captions), scored against every category with one matrix product over the
library (``vector_index.video_scores``). ``list_categories`` names the ones in
use (Settings -> AI); the Recommended feed applies the same rule to its own
picks (``discovery/categories.py``).
"""

from __future__ import annotations

from collections import Counter

import numpy as np
from sqlmodel import Session, select

from ...models import AiCategory, Video
from .. import app_settings
from . import embeddings, vector_index

# Stronger threshold so categories don't pad with unrelated videos.
CATEGORY_MIN_SCORE = 0.55
CATEGORY_SCORE_FLOOR = 0.35
CATEGORY_RELATIVE_DELTA = 0.08
# A video joins a category only when it scores within this of its best category,
# so a cooking video does not also land on "Homelab Networking" at 0.4.
CATEGORY_COMPETE_MARGIN = 0.04


def category_min_score() -> float:
    ai = app_settings.ai_settings()
    return app_settings.clamp_category_min_score(
        ai.get("category_min_score", CATEGORY_MIN_SCORE)
    )


def _hidden_video_ids(session: Session) -> set[int]:
    """Videos waiting in review: indexed, but not shown on shelves."""
    return {
        int(vid)
        for vid in session.exec(
            select(Video.id).where(Video.needs_review == True)  # noqa: E712 - SQL column comparison, not a Python truth test
        ).all()
        if vid is not None
    }


def category_vectors(session: Session) -> list[tuple[str, list[float]]]:
    """The named categories' embeddings, in name order (one dimension)."""
    rows = session.exec(select(AiCategory).order_by(AiCategory.name)).all()
    named: list[tuple[str, list[float]]] = []
    for row in rows:
        vec = embeddings.unpack_vector(row.embedding, row.dim)
        if vec:
            named.append((row.name, vec))
    if not named:
        return []
    # Categories are refreshed together, so they share one dimension; any left
    # over from an older embed model cannot be compared and are skipped.
    dim = Counter(len(vec) for _, vec in named).most_common(1)[0][0]
    return [(name, vec) for name, vec in named if len(vec) == dim]


def category_members(scores: np.ndarray) -> list[np.ndarray]:
    """For each category (a column of ``scores``), its rows, best first.

    A row belongs to a category when it clears the score floor, scores within
    ``CATEGORY_COMPETE_MARGIN`` of its best category, and either clears the
    strictness setting or is within ``CATEGORY_RELATIVE_DELTA`` of the
    category's top hit (cosine ranges differ between embed models).
    """
    min_score = category_min_score()
    best = scores.max(axis=1)
    out: list[np.ndarray] = []
    for j in range(scores.shape[1]):
        column = scores[:, j]
        top = float(column.max())
        keep = (
            (column >= CATEGORY_SCORE_FLOOR)
            & (column >= best - CATEGORY_COMPETE_MARGIN)
            & ((column >= min_score) | (column >= top - CATEGORY_RELATIVE_DELTA))
        )
        picked = np.flatnonzero(keep)
        out.append(picked[np.argsort(-column[picked], kind="stable")])
    return out


def _category_assignments(session: Session) -> dict[str, list[tuple[int, float]]]:
    """Each category's library videos, best first (see ``category_members``)."""
    named = category_vectors(session)
    if not named:
        return {}
    video_ids, scores = vector_index.video_scores(session, [v for _, v in named])
    hidden = _hidden_video_ids(session)
    if hidden and video_ids.size:
        visible = ~np.isin(video_ids, np.fromiter(hidden, np.int64, len(hidden)))
        video_ids, scores = video_ids[visible], scores[visible]
    if video_ids.size == 0:
        return {}

    out: dict[str, list[tuple[int, float]]] = {}
    for j, ((name, _vec), order) in enumerate(
        zip(named, category_members(scores), strict=True)
    ):
        hits = [(int(video_ids[i]), float(scores[i, j])) for i in order]
        if hits:
            out[name] = hits
    return out


def list_categories(session: Session, *, nonempty_only: bool = True) -> list[str]:
    if not nonempty_only:
        rows = session.exec(select(AiCategory).order_by(AiCategory.name)).all()
        return [r.name for r in rows]
    return list(_category_assignments(session))
