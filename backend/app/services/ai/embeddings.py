"""SQLite-backed float32 embedding store and cosine similarity helpers."""

from __future__ import annotations

import struct
from typing import Optional

from sqlmodel import Session, select

from ...models import Video, VideoAiMeta, VideoEmbedding, utcnow
from .. import app_settings
from . import text as ai_text
from .provider import get_provider


def pack_vector(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def unpack_vector(blob: bytes, dim: Optional[int] = None) -> list[float]:
    if not blob:
        return []
    n = dim or (len(blob) // 4)
    if n <= 0 or len(blob) < n * 4:
        n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob[: n * 4]))


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))


def _get_or_create_meta(session: Session, video_id: int) -> VideoAiMeta:
    meta = session.get(VideoAiMeta, video_id)
    if meta is None:
        meta = VideoAiMeta(video_id=video_id)
        session.add(meta)
        session.flush()
    return meta


def delete_embeddings(session: Session, video_id: int) -> None:
    rows = session.exec(
        select(VideoEmbedding).where(VideoEmbedding.video_id == video_id)
    ).all()
    for row in rows:
        session.delete(row)
    session.commit()


def embed_video(session: Session, video_id: int) -> bool:
    """Compute and store embeddings for a video. Returns True on success."""
    video = session.get(Video, video_id)
    if video is None or video.needs_review:
        return False

    provider = get_provider()
    if provider is None:
        return False

    ai = app_settings.ai_settings()
    model = str(ai.get("embed_model") or "nomic-embed-text")
    use_subs = bool(ai.get("use_subtitles", True))
    digest = ai_text.content_hash(video, use_subtitles=use_subs)
    meta = _get_or_create_meta(session, video_id)
    if meta.content_hash == digest and meta.embed_status == "ready":
        existing = session.exec(
            select(VideoEmbedding).where(VideoEmbedding.video_id == video_id)
        ).first()
        if existing is not None:
            return True

    docs = ai_text.documents_for_video(video, use_subtitles=use_subs)
    # Remove old rows for this video.
    old = session.exec(
        select(VideoEmbedding).where(VideoEmbedding.video_id == video_id)
    ).all()
    for row in old:
        session.delete(row)
    session.flush()

    try:
        for chunk_index, doc in docs:
            if not doc.strip():
                continue
            vec = provider.embed(doc, model)
            row = VideoEmbedding(
                video_id=video_id,
                chunk_index=chunk_index,
                model=model,
                dim=len(vec),
                vector=pack_vector(vec),
                content_hash=digest,
                updated_at=utcnow(),
            )
            session.add(row)
        meta.embed_status = "ready"
        meta.content_hash = digest
        meta.updated_at = utcnow()
        session.add(meta)
        session.commit()
        return True
    except Exception as exc:  # noqa: BLE001
        session.rollback()
        meta = _get_or_create_meta(session, video_id)
        meta.embed_status = "error"
        meta.updated_at = utcnow()
        session.add(meta)
        session.commit()
        raise RuntimeError(str(exc)) from exc


def embed_query(query: str) -> Optional[list[float]]:
    provider = get_provider()
    if provider is None or not query.strip():
        return None
    ai = app_settings.ai_settings()
    model = str(ai.get("embed_model") or "nomic-embed-text")
    try:
        return provider.embed(query.strip(), model)
    except Exception:  # noqa: BLE001
        return None


def video_centroid(session: Session, video_id: int) -> Optional[list[float]]:
    rows = session.exec(
        select(VideoEmbedding).where(VideoEmbedding.video_id == video_id)
    ).all()
    if not rows:
        return None
    # Prefer metadata doc; else average all chunks.
    meta_rows = [r for r in rows if r.chunk_index == -1]
    use = meta_rows or list(rows)
    vectors = [unpack_vector(r.vector, r.dim) for r in use]
    vectors = [v for v in vectors if v]
    if not vectors:
        return None
    dim = len(vectors[0])
    acc = [0.0] * dim
    for v in vectors:
        if len(v) != dim:
            continue
        for i, x in enumerate(v):
            acc[i] += x
    n = float(len(vectors))
    return [x / n for x in acc]


def similar_video_ids(
    session: Session,
    query_vec: list[float],
    *,
    limit: int = 24,
    exclude_ids: Optional[set[int]] = None,
    min_score: float = 0.15,
) -> list[tuple[int, float]]:
    """Return (video_id, score) sorted by descending cosine similarity.

    Scores videos by their best-matching chunk (max over chunks).
    """
    exclude_ids = exclude_ids or set()
    rows = session.exec(select(VideoEmbedding)).all()
    best: dict[int, float] = {}
    for row in rows:
        if row.video_id in exclude_ids:
            continue
        vec = unpack_vector(row.vector, row.dim)
        score = cosine(query_vec, vec)
        if score < min_score:
            continue
        prev = best.get(row.video_id)
        if prev is None or score > prev:
            best[row.video_id] = score

    ranked = sorted(best.items(), key=lambda kv: kv[1], reverse=True)
    return ranked[:limit]


def indexed_count(session: Session) -> tuple[int, int]:
    """Return (indexed_ready, total_library_videos)."""
    total = len(
        session.exec(
            select(Video.id).where(Video.needs_review == False)  # noqa: E712
        ).all()
    )
    ready = len(
        session.exec(
            select(VideoAiMeta.video_id).where(VideoAiMeta.embed_status == "ready")
        ).all()
    )
    return ready, total


def videos_needing_embed(session: Session, *, limit: int = 500) -> list[int]:
    ai = app_settings.ai_settings()
    use_subs = bool(ai.get("use_subtitles", True))
    videos = session.exec(
        select(Video).where(Video.needs_review == False)  # noqa: E712
    ).all()
    need: list[int] = []
    for video in videos:
        if video.id is None:
            continue
        meta = session.get(VideoAiMeta, video.id)
        digest = ai_text.content_hash(video, use_subtitles=use_subs)
        if meta is None or meta.embed_status != "ready" or meta.content_hash != digest:
            need.append(video.id)
            if len(need) >= limit:
                break
    return need


def lock_tags_on_manual_edit(session: Session, video_id: int) -> None:
    from .. import library as lib

    meta = _get_or_create_meta(session, video_id)
    meta.tags_locked = True
    video = session.get(Video, video_id)
    if video is not None and meta.ai_tags:
        current = {t.lower() for t in lib.parse_tags(video.tags)}
        kept = [t for t in lib.parse_tags(meta.ai_tags) if t.lower() in current]
        meta.ai_tags = lib.dump_tags(kept)
    meta.updated_at = utcnow()
    session.add(meta)
