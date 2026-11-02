"""Topics a user adds to Recommended+ by hand: interests and blocks.

An **interest** ("europe travel vlogs") gets its own share of the feed, by its
strength, and becomes a YouTube search for the gatherer. A video matches when
the interest's words are in its title, channel or tags, when it was found by
searching for the interest, or (with embeddings) when it stands out as close
to the interest's text among the candidates.

A **block** leaves videos out: by its words (Recommended+, the Recommended
shelves and what the gatherer stores; not the live row) or, with embeddings, by meaning (Recommended+, which reads the
vectors). Meaning is judged against the pool: a candidate counts as close when
its similarity to the topic is far above the pool's (``BLOCK_Z``), since raw
similarities mean different things on different embed models.

Topics past ``expires_at`` are kept, switched off, until turned on again.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
from sqlmodel import Session, col, select

from ...models import RecTopic, as_utc, utcnow
from ..ai.embeddings import embed_query
from ..ai.provider import get_embed_provider, resolve_embed_model
from .runtime import DiscoveryRuntime

KINDS = ("interest", "block")
MATCHES = ("words", "similar")
STRENGTHS = ("low", "normal", "high")
MAX_TEXT = 80
#: Interests switched on at once, and blocks in all.
MAX_ACTIVE_INTERESTS = 10
MAX_BLOCKS = 50
#: The share of the feed each active interest is owed, and their cap together.
STRENGTH_SHARE = {"low": 0.04, "normal": 0.08, "high": 0.14}
INTEREST_SHARE_CAP = 0.35
#: How far above the pool's mean (in standard deviations) a candidate must be
#: to match an interest by meaning, or to be left out by a "similar" block.
INTEREST_Z = 2.0
BLOCK_Z = 2.5
#: ...and in any case at least this similar: a pool with nothing about the
#: topic has outliers too. Unrelated text sits well below it on the usual embed
#: models; this is a floor, not the line that decides.
MIN_TOPIC_COSINE = 0.35
#: A topic whose embedding failed is not tried again for this long, and one
#: ranking embeds at most this many new topics (the rest wait for the next).
EMBED_RETRY_SEC = 600
EMBEDS_PER_RANKING = 3


def _pattern(text: str) -> re.Pattern[str] | None:
    """The topic's words, in order, as whole words (any separators between)."""
    words = re.findall(r"\w+", text.casefold())
    if not words:
        return None
    return re.compile(r"\b" + r"\W+".join(re.escape(w) for w in words) + r"\b")


@dataclass
class Topic:
    id: int
    kind: str
    text: str
    match: str
    strength: str
    pattern: re.Pattern[str] | None

    def in_text(self, haystack: str) -> bool:
        return self.pattern is not None and bool(self.pattern.search(haystack))


@dataclass
class Topics:
    """One user's switched-on topics."""

    interests: list[Topic] = field(default_factory=list)
    blocks: list[Topic] = field(default_factory=list)

    @property
    def interest_share(self) -> float:
        total = sum(STRENGTH_SHARE.get(t.strength, 0.08) for t in self.interests)
        return min(INTEREST_SHARE_CAP, total)

    def word_block(self, haystack: str) -> Topic | None:
        """The first block whose words are in ``haystack`` (lowercased text)."""
        for t in self.blocks:
            if t.in_text(haystack):
                return t
        return None


def haystack(title: str | None, channel: str | None, tags: list[str]) -> str:
    """What a video's words are matched against."""
    return " ".join([title or "", channel or "", *tags]).casefold()


def is_active(row: RecTopic, now: datetime) -> bool:
    return row.expires_at is None or as_utc(row.expires_at) > now


def listed(session: Session, user_id: int) -> list[RecTopic]:
    """All of the user's topics, interests first, newest first."""
    rows = session.exec(
        select(RecTopic)
        .where(RecTopic.user_id == user_id)
        .order_by(col(RecTopic.created_at).desc(), col(RecTopic.id).desc())
    ).all()
    return sorted(rows, key=lambda r: r.kind != "interest")


def active(session: Session, user_id: int, now: datetime | None = None) -> Topics:
    now = now or utcnow()
    out = Topics()
    for row in listed(session, user_id):
        if not is_active(row, now) or row.id is None:
            continue
        topic = Topic(
            row.id, row.kind, row.text, row.match, row.strength, _pattern(row.text)
        )
        (out.interests if row.kind == "interest" else out.blocks).append(topic)
    # Strongest interests first (they are searched for first).
    out.interests.sort(key=lambda t: STRENGTHS.index(t.strength), reverse=True)
    return out


def topic_vector(
    runtime: DiscoveryRuntime, text: str, *, may_embed: bool = True
) -> np.ndarray | None:
    """The unit vector of ``text`` with the current embed model (kept in memory).

    Asks the provider only when ``may_embed`` and it did not fail on this text in
    the last ``EMBED_RETRY_SEC``; otherwise None until a later ranking.
    """
    provider = get_embed_provider()
    if provider is None:
        return None
    key = (resolve_embed_model(provider), text.strip().casefold())
    cached = runtime.topic_vector(key)
    if cached is not None:
        vec, at = cached
        if vec.size or time.monotonic() - at < EMBED_RETRY_SEC:
            return vec if vec.size else None
    if not may_embed:
        return None
    raw = embed_query(text)
    vec = np.asarray(raw or [], dtype=np.float32)
    norm = float(np.linalg.norm(vec)) if vec.size else 0.0
    vec = vec / norm if norm > 0 else np.zeros(0, dtype=np.float32)
    # A failure (empty) is remembered too, for EMBED_RETRY_SEC.
    runtime.store_topic_vector(key, (vec, time.monotonic()))
    return vec if vec.size else None


def topic_vectors(
    runtime: DiscoveryRuntime, texts: list[str]
) -> list[np.ndarray | None]:
    """``topic_vector`` of each text, asking the provider for at most
    ``EMBEDS_PER_RANKING`` of them (so a slow provider cannot stall a ranking)."""
    out: list[np.ndarray | None] = []
    budget = EMBEDS_PER_RANKING
    for text in texts:
        vec = topic_vector(runtime, text, may_embed=False)
        if vec is None and budget > 0 and not _failed_lately(runtime, text):
            budget -= 1
            vec = topic_vector(runtime, text)
        out.append(vec)
    return out


def _failed_lately(runtime: DiscoveryRuntime, text: str) -> bool:
    provider = get_embed_provider()
    if provider is None:
        return True
    cached = runtime.topic_vector(
        (resolve_embed_model(provider), text.strip().casefold())
    )
    return cached is not None and not cached[0].size


def active_ids(session: Session, user_id: int) -> tuple[int, ...]:
    """The ids of the user's switched-on topics (changes when one expires)."""
    now = utcnow()
    return tuple(
        sorted(r.id for r in listed(session, user_id) if r.id and is_active(r, now))
    )


def standout(sims: np.ndarray) -> np.ndarray:
    """How far each row's similarity is above the pool's, in standard deviations
    (per column; NaN rows, without a vector, stay NaN)."""
    out = np.full(sims.shape, np.nan, dtype=np.float32)
    for j in range(sims.shape[1]):
        column = sims[:, j]
        finite = column[np.isfinite(column)]
        if finite.size < 5:
            continue  # Too few to say what stands out.
        std = float(finite.std())
        if std <= 1e-6:
            continue
        out[:, j] = (column - float(finite.mean())) / std
    return out


class TooMany(ValueError):
    """Over ``MAX_ACTIVE_INTERESTS`` switched-on interests, or ``MAX_BLOCKS`` blocks."""


def _check_room(session: Session, user_id: int, row: RecTopic, now: datetime) -> None:
    others = [r for r in listed(session, user_id) if r.id != row.id]
    if row.kind == "interest" and is_active(row, now):
        on = sum(1 for r in others if r.kind == "interest" and is_active(r, now))
        if on >= MAX_ACTIVE_INTERESTS:
            raise TooMany(f"At most {MAX_ACTIVE_INTERESTS} interests can be on at once")
    blocks = sum(1 for r in others if r.kind == "block")
    if row.kind == "block" and row.id is None and blocks >= MAX_BLOCKS:
        raise TooMany(f"At most {MAX_BLOCKS} blocked topics")


def create(
    session: Session,
    user_id: int,
    *,
    kind: str,
    text: str,
    match: str,
    strength: str,
    expires_at: datetime | None,
) -> RecTopic:
    row = RecTopic(
        user_id=user_id,
        kind=kind,
        text=" ".join(text.split())[:MAX_TEXT],
        match=match,
        strength=strength,
        expires_at=expires_at,
    )
    _check_room(session, user_id, row, utcnow())
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def update(session: Session, row: RecTopic, changes: dict[str, object]) -> RecTopic:
    """Apply ``changes`` (already validated: text, match, strength, expires_at)."""
    for key, value in changes.items():
        if key == "text" and isinstance(value, str):
            value = " ".join(value.split())[:MAX_TEXT]
        setattr(row, key, value)
    _check_room(session, row.user_id, row, utcnow())
    session.add(row)
    session.commit()
    session.refresh(row)
    return row
