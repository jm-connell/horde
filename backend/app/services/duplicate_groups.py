"""Duplicate-video clustering for the review screen, with a small result cache.

Finding the clusters compares every library video with every other one, so it is
quadratic. The page endpoint is called once per page of groups, so the grouping is
cached under a fingerprint of everything it reads. The fingerprint covers each
video's id and the fields the heuristics compare (title, channel, duration and the
places a YouTube id is read from), so a new, deleted, renamed or edited video
changes it and the next request recomputes; nothing has to remember to invalidate.
"""

from __future__ import annotations

import hashlib
import re
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import select as sa_select
from sqlmodel import Session, col

from ..models import Video

#: Distinct fingerprints kept. One library has one live fingerprint; a couple more
#: absorb a page request that races an edit.
MAX_ENTRIES = 4

_JACCARD_MIN = 0.7
_MAX_DURATION_GAP_SEC = 5


@dataclass(frozen=True)
class VideoFacts:
    """The fields of a library video that grouping reads."""

    id: int
    title: str | None
    channel: str | None
    duration_sec: int | float | None
    source_url: str | None
    file_path: str


@dataclass(frozen=True)
class DuplicateGroup:
    match_type: str  # youtube_id | heuristic
    video_ids: tuple[int, ...]


def load_facts(session: Session) -> list[VideoFacts]:
    rows = session.execute(
        sa_select(  # sqlmodel's select stops at four columns
            col(Video.id),
            col(Video.title),
            col(Video.channel),
            col(Video.duration_sec),
            col(Video.source_url),
            col(Video.file_path),
        )
        .where(col(Video.needs_review) == False)  # noqa: E712 - SQL column comparison, not a Python truth test
        .order_by(col(Video.id))
    ).all()
    return [VideoFacts(*row) for row in rows]


def fingerprint(facts: list[VideoFacts]) -> str:
    digest = hashlib.sha256()
    for f in facts:
        digest.update(repr(f).encode())
    return f"{len(facts)}:{digest.hexdigest()}"


def _yt_id(facts: VideoFacts) -> str | None:
    """Extract the YouTube video id from source_url or file_path."""
    for text in (facts.source_url or "", facts.file_path):
        m = re.search(r"\[([A-Za-z0-9_-]{11})\]", text)
        if m:
            return m.group(1)
        m = re.search(r"(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})", text)
        if m:
            return m.group(1)
    return None


def _title_tokens(title: str) -> set[str]:
    return set(re.sub(r"[^a-z0-9 ]", "", title.lower()).split())


def compute_groups(facts: list[VideoFacts]) -> list[DuplicateGroup]:
    """Group 1: same YouTube id. Group 2: same channel, similar title and duration."""
    by_yt_id: dict[str, list[VideoFacts]] = {}
    for v in facts:
        yt_id = _yt_id(v)
        if yt_id:
            by_yt_id.setdefault(yt_id, []).append(v)

    used: set[int] = set()
    groups: list[DuplicateGroup] = []
    for vids in by_yt_id.values():
        if len(vids) > 1:
            groups.append(DuplicateGroup("youtube_id", tuple(v.id for v in vids)))
            used.update(v.id for v in vids)

    for i, va in enumerate(facts):
        if va.id in used:
            continue
        if not va.channel or not va.title or not va.duration_sec:
            continue
        tokens_a = _title_tokens(va.title)
        cluster = [va]
        for vb in facts[i + 1 :]:
            if vb.id in used or vb.channel != va.channel:
                continue
            if not vb.title or not vb.duration_sec:
                continue
            if abs(va.duration_sec - vb.duration_sec) > _MAX_DURATION_GAP_SEC:
                continue
            tokens_b = _title_tokens(vb.title)
            if tokens_a and tokens_b:
                overlap = len(tokens_a & tokens_b) / len(tokens_a | tokens_b)
                if overlap >= _JACCARD_MIN:
                    cluster.append(vb)
        if len(cluster) > 1:
            used.update(v.id for v in cluster)
            groups.append(DuplicateGroup("heuristic", tuple(v.id for v in cluster)))
    return groups


class DuplicateGroupCache:
    """Bounded LRU of computed groupings, keyed by input fingerprint.

    Built in ``lifespan`` and kept on ``app.state.duplicate_groups``. ``computes``
    counts real clusterings, which is what the tests assert on.
    """

    def __init__(self, max_entries: int = MAX_ENTRIES) -> None:
        self._max = max_entries
        self._entries: OrderedDict[str, list[DuplicateGroup]] = OrderedDict()
        self._lock = threading.Lock()
        self.computes = 0

    def groups(
        self,
        facts: list[VideoFacts],
        compute: Callable[[list[VideoFacts]], list[DuplicateGroup]] = compute_groups,
    ) -> list[DuplicateGroup]:
        key = fingerprint(facts)
        # Held across the compute so two simultaneous first pages cluster once.
        with self._lock:
            hit = self._entries.get(key)
            if hit is not None:
                self._entries.move_to_end(key)
                return hit
            groups = compute(facts)
            self.computes += 1
            self._entries[key] = groups
            while len(self._entries) > self._max:
                self._entries.popitem(last=False)
            return groups
