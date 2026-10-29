"""Every video Recommended+ may show, and the vectors that score it.

Three pools, one key space (the YouTube id; ``video:<id>`` for a library video
without one), and a video in more than one pool is listed once, from the first
of: the library, a channel catalog, the discovered videos.

Library vectors come from ``vector_index`` (whole-video profiles). Catalog and
discovered vectors are stacked into one matrix (``VectorStore``) rebuilt only
when their rows change, so scoring a feed is a matrix product, not a decode.
"""

from __future__ import annotations

import threading
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import numpy as np
from sqlalchemy import func
from sqlalchemy import select as sa_select
from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

from ...models import (
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogSkip,
    ChannelCatalogVideo,
    DiscoveryVideo,
    Video,
    VideoTag,
)
from ..channel_catalog.query import is_hidden_catalog_video
from ..follows import normalize_channel_url
from .history import library_key


def parse_published(raw: str | datetime | None) -> datetime | None:
    """A publish date from a datetime, ISO text, or yt-dlp's YYYYMMDD."""
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=UTC)
    text = raw.strip()
    if not text:
        return None
    try:
        if len(text) == 8 and text.isdigit():
            return datetime.strptime(text, "%Y%m%d").replace(tzinfo=UTC)
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


@dataclass
class Candidate:
    key: str
    #: library | catalog | discovery
    pool: str
    title: str
    channel: str
    channel_url: str
    yt_id: str | None = None
    video_id: int | None = None
    #: The ``discovery_videos`` id (pool ``discovery``).
    discovery_id: int | None = None
    # How a video that is not downloaded is shown (copied from its row: the
    # ranked feed is cached across requests, where ORM rows would expire).
    url: str = ""
    thumbnail_url: str | None = None
    published_raw: str | None = None
    published_label: str | None = None
    live_status: str | None = None
    #: The channel as the source spelled it (``channel_url`` is normalized).
    source_channel_url: str | None = None
    published: datetime | None = None
    duration: float | None = None
    view_count: int | None = None
    tags: list[str] = field(default_factory=list)


def library_candidates(session: Session) -> list[Candidate]:
    out: list[Candidate] = []
    rows = session.execute(
        sa_select(
            col(Video.id),
            col(Video.youtube_id),
            col(Video.title),
            col(Video.channel),
            col(Video.channel_url),
            col(Video.published_at),
            col(Video.added_at),
            col(Video.duration_sec),
            col(Video.view_count),
        ).where(col(Video.needs_review) == False)  # noqa: E712 - SQL column comparison, not a Python truth test
    ).all()
    tags: dict[int, list[str]] = {}
    for vid, tag in session.exec(select(VideoTag.video_id, VideoTag.tag)).all():
        tags.setdefault(vid, []).append(tag.lower())
    for vid, yt_id, title, channel, channel_url, published, added, dur, views in rows:
        if vid is None:
            continue
        out.append(
            Candidate(
                key=library_key(vid, yt_id),
                pool="library",
                title=title or "",
                channel=(channel or "").strip(),
                channel_url=normalize_channel_url(channel_url or ""),
                yt_id=yt_id,
                video_id=vid,
                published=parse_published(published or added),
                duration=dur,
                view_count=views,
                tags=tags.get(vid, []),
            )
        )
    return out


def catalog_candidates(session: Session, exclude: set[str]) -> list[Candidate]:
    """Visible catalog videos of every indexed channel (not only followed ones)."""
    names = {
        cid: (normalize_channel_url(url), (name or "").strip())
        for cid, url, name in session.exec(
            select(
                ChannelCatalog.id,
                ChannelCatalog.channel_url,
                ChannelCatalog.channel_name,
            )
        ).all()
    }
    # Unplayable videos, and videos a user deleted: neither is worth suggesting.
    skipped = {
        (cid, yt_id)
        for cid, yt_id in session.exec(
            select(ChannelCatalogSkip.catalog_id, ChannelCatalogSkip.yt_id)
        ).all()
    }
    out: list[Candidate] = []
    for row in session.exec(
        select(ChannelCatalogVideo).options(
            defer(col(ChannelCatalogVideo.description))  # type: ignore[arg-type]  # SQLModel attribute vs. the loader option signature
        )
    ).all():
        if row.yt_id in exclude or (row.catalog_id, row.yt_id) in skipped:
            continue
        if row.live_status in ("is_live", "is_upcoming"):
            continue  # The Live row lists these.
        if is_hidden_catalog_video(row, set()):
            continue
        channel_url, channel = names.get(row.catalog_id, ("", ""))
        out.append(
            Candidate(
                key=row.yt_id,
                pool="catalog",
                title=row.title or "",
                channel=channel,
                channel_url=channel_url,
                yt_id=row.yt_id,
                url=row.url,
                thumbnail_url=row.thumbnail_url,
                published_raw=row.published_at,
                live_status=row.live_status,
                source_channel_url=channel_url or None,
                published=parse_published(row.published_at),
                duration=row.duration,
                view_count=row.view_count,
            )
        )
        exclude.add(row.yt_id)
    return out


def discovered_candidates(
    session: Session, exclude: set[str], ids: set[int]
) -> list[Candidate]:
    """The discovered videos with ``ids`` (those hit for this user)."""
    if not ids:
        return []
    out: list[Candidate] = []
    for row in session.exec(
        select(DiscoveryVideo).where(col(DiscoveryVideo.id).in_(list(ids)))
    ).all():
        if row.yt_id in exclude:
            continue
        out.append(
            Candidate(
                key=row.yt_id,
                pool="discovery",
                title=row.title or "",
                channel=(row.channel or "").strip(),
                channel_url=normalize_channel_url(row.channel_url or ""),
                yt_id=row.yt_id,
                discovery_id=row.id,
                url=row.url,
                thumbnail_url=row.thumbnail_url,
                published_raw=row.published_at,
                published_label=row.published_label,
                live_status=row.live_status,
                source_channel_url=row.channel_url,
                published=parse_published(row.published_at),
                duration=row.duration,
                view_count=row.view_count,
            )
        )
        exclude.add(row.yt_id)
    return out


@dataclass
class _Matrix:
    fingerprint: tuple[Any, ...]
    dim: int
    keys: list[str]
    index: dict[str, int]
    rows: np.ndarray


def _unit_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    out: np.ndarray = np.divide(
        matrix, norms, out=np.zeros_like(matrix), where=norms > 0
    )
    return out


class VectorStore:
    """Catalog and discovered vectors by YouTube id, as one matrix of unit rows.

    Held on the ``DiscoveryRuntime``. ``matrix`` rebuilds when the rows behind
    it change (a cheap aggregate query decides) and otherwise returns the last
    build. The catalog vector wins when a video is in both.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._built: _Matrix | None = None

    @staticmethod
    def _fingerprint(session: Session) -> tuple[Any, ...]:
        catalog = session.execute(
            sa_select(
                func.count(col(ChannelCatalogEmbedding.id)),
                func.max(col(ChannelCatalogEmbedding.id)),
                func.max(col(ChannelCatalogEmbedding.updated_at)),
                func.max(col(ChannelCatalogEmbedding.model)),
            )
        ).one()
        discovered = session.execute(
            sa_select(
                func.count(col(DiscoveryVideo.id)),
                func.max(col(DiscoveryVideo.id)),
                func.count(func.distinct(col(DiscoveryVideo.embed_model))),
                func.min(col(DiscoveryVideo.embed_model)),
                func.max(col(DiscoveryVideo.embed_model)),
                func.sum(col(DiscoveryVideo.embed_dim)),
            )
        ).one()
        return (*catalog, *discovered)

    def matrix(self, session: Session) -> _Matrix:
        fingerprint = self._fingerprint(session)
        with self._lock:
            built = self._built
            if built is not None and built.fingerprint == fingerprint:
                return built
        blobs: dict[str, tuple[int, bytes]] = {}
        for yt_id, dim, blob in session.exec(
            select(
                DiscoveryVideo.yt_id, DiscoveryVideo.embed_dim, DiscoveryVideo.vector
            ).where(DiscoveryVideo.embed_dim > 0)
        ).all():
            blobs[yt_id] = (dim, blob)
        for yt_id, dim, blob in session.exec(
            select(
                ChannelCatalogVideo.yt_id,
                ChannelCatalogEmbedding.dim,
                ChannelCatalogEmbedding.vector,
            ).join(
                ChannelCatalogVideo,
                col(ChannelCatalogEmbedding.catalog_video_id)
                == col(ChannelCatalogVideo.id),
            )
        ).all():
            if dim:
                blobs[yt_id] = (dim, blob)
        # Rows from an older embed model cannot be compared: keep the common size.
        dims = Counter(dim for dim, _blob in blobs.values())
        dim = dims.most_common(1)[0][0] if dims else 0
        keys = [k for k, (d, blob) in blobs.items() if d == dim and len(blob) >= 4 * d]
        rows = np.zeros((len(keys), dim), dtype=np.float32)
        for i, key in enumerate(keys):
            rows[i] = np.frombuffer(blobs[key][1], dtype=np.float32, count=dim)
        built = _Matrix(
            fingerprint=fingerprint,
            dim=dim,
            keys=keys,
            index={k: i for i, k in enumerate(keys)},
            rows=_unit_rows(rows),
        )
        with self._lock:
            self._built = built
        return built

    def vectors(self, session: Session, yt_ids: list[str]) -> dict[str, np.ndarray]:
        built = self.matrix(session)
        return {k: built.rows[built.index[k]] for k in yt_ids if k in built.index}
