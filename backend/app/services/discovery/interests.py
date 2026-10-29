"""A user's interests (groups of their watches) and the YouTube searches they make.

The history splits in two: **recent** watches (the last ``RECENT_DAYS``, widened
to ``THROWBACK_AFTER_DAYS`` in a quiet month) and **older** ones (``THROWBACK_AFTER_DAYS`` to three
years back). Each part is grouped by embedding (spherical k-means; by channel
without AI). An older group that is close to a recent one is not dormant and is
dropped, so "throwback" means something the user has not been watching lately.

Searches come from the chat model when one is set up (two per group, aimed at
other creators), else from the words that set each group's titles apart from
the rest of the history, else from its tags.
"""

from __future__ import annotations

import logging
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np
from sqlmodel import Session, col, select

from ...models import VideoTag
from ..ai import tasks as ai_tasks
from ..ai import vector_index
from ..ai.provider import (
    get_llm_provider,
    llm_features_allowed,
    require_llm_chat_model,
    resolve_llm_model,
)
from .history import Watch
from .runtime import DiscoveryRuntime

logger = logging.getLogger(__name__)

RECENT_DAYS = 30
#: Fewer recent watches than this widens "recent" (see ``split_history``).
RECENT_MIN = 8
RECENT_MAX = 80
THROWBACK_AFTER_DAYS = 60
THROWBACK_MAX_DAYS = 3 * 365
THROWBACK_MAX = 150
#: A recent watch counts half as much after this many days.
RECENT_HALF_LIFE_DAYS = 10.0
#: An older group at least this close to a recent one is still active.
DORMANT_SIMILARITY = 0.8
MAX_RECENT_INTERESTS = 6
MAX_THROWBACK_INTERESTS = 3
#: Watches that barely say anything (opened, left) do not seed a group alone.
MIN_GROUP_WEIGHT = 0.3

_WORD_RE = re.compile(r"[^\W\d_]{3,}", re.UNICODE)
_STOPWORDS = frozenset(
    """
    the and for with you your this that from into about what why how when who
    are was were has have had not but all any can will just more most best new
    out our its it's his her their them they then than too very part full video
    videos official episode ep vs live stream streams shorts short day days week
    year years one two three first last get got make made using use way time
    review reaction reacts react trailer highlights compilation update tutorial
    guide tips tricks top ultimate complete everything ever really
    """.split()  # noqa: SIM905 - a word list reads better as text
)


@dataclass
class Interest:
    era: str
    #: Members, strongest first, with their weights.
    watches: list[Watch]
    weights: list[float]
    centroid: np.ndarray | None = None
    queries: list[str] = field(default_factory=list)

    @property
    def weight(self) -> float:
        return float(sum(self.weights))

    @property
    def channels(self) -> list[str]:
        counts: dict[str, float] = defaultdict(float)
        for w, weight in zip(self.watches, self.weights, strict=True):
            if w.channel:
                counts[w.channel] += weight
        return _top(counts)


def _top(weights: dict[str, float], n: int | None = None) -> list[str]:
    """Keys by weight, heaviest first (ties keep insertion order)."""
    return sorted(weights, key=lambda k: -weights[k])[:n]


def watch_weight(watch: Watch, now: datetime, half_life_days: float) -> float:
    age = max(0.0, (now - watch.watched_at).total_seconds() / 86400)
    return float(0.5 ** (age / half_life_days)) * watch.engagement


def split_history(
    watches: list[Watch], now: datetime
) -> tuple[list[Watch], list[Watch]]:
    """(recent, older) watches, newest first, as described in the module docstring."""
    recent_cut = now - timedelta(days=RECENT_DAYS)
    recent = [w for w in watches if w.watched_at >= recent_cut][:RECENT_MAX]
    if len(recent) < RECENT_MIN:
        # A quiet month: look back as far as the throwback line, never past it,
        # or old interests would pass for current ones.
        wider = now - timedelta(days=THROWBACK_AFTER_DAYS)
        recent = [w for w in watches if w.watched_at >= wider][:RECENT_MAX]
    if not recent:
        # Nothing for months: the last watches are what the user is "into".
        recent = watches[:RECENT_MIN]
    taken = {w.key for w in recent}
    old_cut = now - timedelta(days=THROWBACK_AFTER_DAYS)
    oldest = now - timedelta(days=THROWBACK_MAX_DAYS)
    older = [
        w for w in watches if w.key not in taken and oldest <= w.watched_at <= old_cut
    ][:THROWBACK_MAX]
    return recent, older


def watch_vectors(
    session: Session, runtime: DiscoveryRuntime, watches: list[Watch]
) -> dict[str, np.ndarray]:
    """Unit vectors of the watches that have one, all of one size."""
    raw: dict[str, np.ndarray] = {}
    library_ids = [w.video_id for w in watches if w.video_id is not None]
    profiles = vector_index.profile_vectors(session, library_ids) if library_ids else {}
    for w in watches:
        if w.video_id is not None and w.video_id in profiles:
            raw[w.key] = np.asarray(profiles[w.video_id], dtype=np.float32)
    streamed = [w.yt_id for w in watches if w.yt_id and w.key not in raw]
    found = runtime.vectors.vectors(session, streamed) if streamed else {}
    for w in watches:
        if w.key not in raw and w.yt_id and w.yt_id in found:
            raw[w.key] = found[w.yt_id]
    if not raw:
        return {}
    dim = Counter(len(v) for v in raw.values()).most_common(1)[0][0]
    out: dict[str, np.ndarray] = {}
    for key, vec in raw.items():
        if len(vec) != dim:
            continue
        norm = float(np.linalg.norm(vec))
        if norm > 0:
            out[key] = vec / norm
    return out


def _kmeans(
    vectors: np.ndarray, weights: np.ndarray, k: int, iterations: int = 12
) -> np.ndarray:
    """Spherical k-means labels; deterministic (heaviest point, then farthest)."""
    n = len(vectors)
    k = max(1, min(k, n))
    centres = [vectors[int(np.argmax(weights))]]
    while len(centres) < k:
        sims = vectors @ np.asarray(centres).T
        distance = (1.0 - sims.max(axis=1)) * weights
        centres.append(vectors[int(np.argmax(distance))])
    c = np.asarray(centres)
    labels = np.zeros(n, dtype=np.int64)
    for _ in range(iterations):
        labels = np.argmax(vectors @ c.T, axis=1)
        moved = False
        for j in range(k):
            members = labels == j
            if not members.any():
                continue
            mean = (vectors[members] * weights[members, None]).sum(axis=0)
            norm = float(np.linalg.norm(mean))
            if norm == 0:
                continue
            new = mean / norm
            if not np.allclose(new, c[j], atol=1e-5):
                moved = True
            c[j] = new
        if not moved:
            break
    return labels


def _group_size(n: int, cap: int) -> int:
    return max(1, min(cap, round(math.sqrt(n / 2))))


def group(
    watches: list[Watch],
    weights: list[float],
    vectors: dict[str, np.ndarray],
    *,
    era: str,
    cap: int,
) -> list[Interest]:
    """Group watches into at most ``cap`` interests, heaviest first."""
    if not watches:
        return []
    with_vec = [i for i, w in enumerate(watches) if w.key in vectors]
    buckets: dict[int, list[int]] = defaultdict(list)
    centroids: dict[int, np.ndarray] = {}
    if len(with_vec) >= 2:
        matrix = np.asarray([vectors[watches[i].key] for i in with_vec])
        w = np.asarray([max(weights[i], 1e-6) for i in with_vec], dtype=np.float32)
        labels = _kmeans(matrix, w, _group_size(len(with_vec), cap))
        for row, label in zip(with_vec, labels, strict=True):
            buckets[int(label)].append(row)
        # Watches without a vector join the group most of their channel is in.
        channel_group: dict[str, Counter[int]] = defaultdict(Counter)
        for label, rows in buckets.items():
            for i in rows:
                channel_group[watches[i].channel][label] += 1
        for i, watch in enumerate(watches):
            if watch.key in vectors:
                continue
            votes = channel_group.get(watch.channel)
            if votes:
                buckets[votes.most_common(1)[0][0]].append(i)
        for label, rows in buckets.items():
            mean = sum(
                (
                    vectors[watches[i].key] * weights[i]
                    for i in rows
                    if watches[i].key in vectors
                ),
                np.zeros(matrix.shape[1], dtype=np.float32),
            )
            norm = float(np.linalg.norm(mean))
            if norm > 0:
                centroids[label] = mean / norm
    else:
        # No embeddings: a channel is an interest.
        by_channel: dict[str, int] = {}
        for i, watch in enumerate(watches):
            name = watch.channel or watch.title
            label = by_channel.setdefault(name, len(by_channel))
            buckets[label].append(i)
    out: list[Interest] = []
    for label, rows in buckets.items():
        rows.sort(key=lambda i: -weights[i])
        interest = Interest(
            era=era,
            watches=[watches[i] for i in rows],
            weights=[weights[i] for i in rows],
            centroid=centroids.get(label),
        )
        if interest.weight >= MIN_GROUP_WEIGHT:
            out.append(interest)
    out.sort(key=lambda it: -it.weight)
    return out[:cap]


def interests(
    session: Session,
    runtime: DiscoveryRuntime,
    history: list[Watch],
    now: datetime,
) -> tuple[list[Interest], list[Interest]]:
    """(recent, dormant older) interests, heaviest first."""
    recent, older = split_history(history, now)
    vectors = watch_vectors(session, runtime, recent + older)
    recent_groups = group(
        recent,
        [watch_weight(w, now, RECENT_HALF_LIFE_DAYS) for w in recent],
        vectors,
        era="recent",
        cap=MAX_RECENT_INTERESTS,
    )
    # Older watches all count alike (they are equally "back then").
    old_groups = group(
        older,
        [w.engagement for w in older],
        vectors,
        era="throwback",
        cap=MAX_THROWBACK_INTERESTS * 2,
    )
    recent_centroids = [g.centroid for g in recent_groups if g.centroid is not None]
    recent_channels = {w.channel for w in recent if w.channel}
    dormant: list[Interest] = []
    for g in old_groups:
        if g.centroid is not None and recent_centroids:
            closest = max(float(g.centroid @ c) for c in recent_centroids)
            if closest >= DORMANT_SIMILARITY:
                continue
        elif g.centroid is None and set(g.channels[:1]) & recent_channels:
            continue
        dormant.append(g)
    return recent_groups, dormant[:MAX_THROWBACK_INTERESTS]


# --- searches ------------------------------------------------------------------

_QUERY_SYSTEM = (
    "You help a home video app find new videos on YouTube for one viewer. "
    "Reply with JSON only."
)


def _query_prompt(groups: list[Interest]) -> str:
    lines = [
        "Below are groups of videos one person watched. For each group, write 2 "
        "YouTube search queries that would find more videos on the same specific "
        "topic, preferably from other creators.",
        "Rules: 2 to 6 words each; specific to the group's topic, never generic "
        '(not "funny videos" or "tutorial"); no channel names; in the language '
        "of the titles.",
        'Return {"groups": [{"group": 1, "queries": ["...", "..."]}]} with one '
        "entry per group.",
        "",
    ]
    for n, g in enumerate(groups, start=1):
        lines.append(f"Group {n}:")
        for w in g.watches[:6]:
            title = " ".join(w.title.split())[:120]
            lines.append(f"- {title} ({w.channel})" if w.channel else f"- {title}")
        lines.append("")
    return "\n".join(lines)


def clean_query(text: str, channels: list[str]) -> str | None:
    """A usable search, or None (too short or long, or just a channel's name)."""
    q = " ".join(str(text or "").replace('"', " ").split()).strip(" -.,:;")
    if not (3 <= len(q) <= 80) or len(q.split()) > 8:
        return None
    lowered = q.lower()
    if any(name and name.lower() == lowered for name in channels):
        return None
    return q


def llm_queries(groups: list[Interest]) -> bool:
    """Fill each group's ``queries`` from the chat model; False when it cannot."""
    allowed, _reason = llm_features_allowed()
    llm = get_llm_provider() if allowed else None
    if llm is None or not groups:
        return False
    model = resolve_llm_model(llm)
    if require_llm_chat_model(llm, model):
        return False
    try:
        raw = llm.chat(
            _query_prompt(groups),
            model,
            system=_QUERY_SYSTEM,
            temperature=0.4,
            timeout=90.0,
            usage_kind="discovery",
        )
    except Exception:
        logger.warning("could not ask the chat model for searches", exc_info=True)
        return False
    data = ai_tasks._parse_json_object(raw)
    items = data.get("groups")
    if not isinstance(items, list):
        return False
    filled = False
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            n = int(item.get("group", 0))
        except TypeError, ValueError:
            continue
        if not 1 <= n <= len(groups):
            continue
        queries = item.get("queries")
        if not isinstance(queries, list):
            continue
        g = groups[n - 1]
        for q in queries[:6]:
            if len(g.queries) >= 3:
                break
            cleaned = clean_query(str(q), g.channels)
            if cleaned and cleaned.lower() not in {x.lower() for x in g.queries}:
                g.queries.append(cleaned)
                filled = True
    return filled


def _words(text: str) -> list[str]:
    return [w.lower() for w in _WORD_RE.findall(text or "")]


def keyword_queries(
    session: Session, groups: list[Interest], history: list[Watch]
) -> None:
    """Without a chat model: each group's distinctive title words, and its tags."""
    df: Counter[str] = Counter()
    for w in history:
        df.update(set(_words(w.title)))
    total = max(1, len(history))
    library_ids = [w.video_id for g in groups for w in g.watches if w.video_id]
    tags_of: dict[int, list[str]] = defaultdict(list)
    if library_ids:
        for vid, tag in session.exec(
            select(VideoTag.video_id, VideoTag.tag).where(
                col(VideoTag.video_id).in_(library_ids)
            )
        ).all():
            tags_of[vid].append(tag.lower().strip())
    for g in groups:
        if g.queries:
            continue
        banned = {part for name in g.channels for part in _words(name)}
        scores: dict[str, float] = defaultdict(float)
        for w, weight in zip(g.watches, g.weights, strict=True):
            for word in set(_words(w.title)):
                if word in _STOPWORDS or word in banned:
                    continue
                scores[word] += weight * math.log(1 + total / df[word])
        top = _top(scores, 3)
        if len(top) >= 2:
            g.queries.append(" ".join(top))
        tag_weight: dict[str, float] = defaultdict(float)
        for w, weight in zip(g.watches, g.weights, strict=True):
            if w.video_id is None:
                continue
            for tag in tags_of.get(w.video_id, []):
                if tag and not set(_words(tag)) & banned:
                    tag_weight[tag] += weight
        tags = _top(tag_weight, 2)
        if len(tags) == 2:
            q = clean_query(" ".join(tags), g.channels)
            if q and q.lower() not in {x.lower() for x in g.queries}:
                g.queries.append(q)
