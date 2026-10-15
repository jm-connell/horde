"""SQLite-backed float32 embedding store and cosine similarity helpers."""

from __future__ import annotations

import struct
from collections.abc import Sequence
from typing import Optional

import numpy as np
from sqlmodel import Session, select

from ...models import Video, VideoAiMeta, VideoEmbedding, utcnow
from .. import app_settings
from . import text as ai_text
from .provider import get_embed_provider, resolve_embed_model


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
    va = np.asarray(a, dtype=np.float64)
    vb = np.asarray(b, dtype=np.float64)
    na = float(np.dot(va, va))
    nb = float(np.dot(vb, vb))
    if na <= 0 or nb <= 0:
        return 0.0
    return float(np.dot(va, vb)) / ((na ** 0.5) * (nb ** 0.5))


# Rows scored per matmul in ``cosine_scores`` — bounds the float32 copy we
# build from the blobs (8192 x 1024 dims ≈ 32 MB).
_SCORE_BATCH_ROWS = 8192


def _blob_dim(blob: bytes, dim: Optional[int]) -> int:
    """Element count ``unpack_vector`` would decode for this blob."""
    n = dim or (len(blob) // 4)
    if n <= 0 or len(blob) < n * 4:
        n = len(blob) // 4
    return n


def cosine_scores(
    query_vec: list[float],
    blobs: Sequence[bytes],
    dims: Sequence[Optional[int]],
) -> np.ndarray:
    """Cosine of ``query_vec`` against each packed float32 blob, vectorized.

    Same result as ``cosine(query_vec, unpack_vector(blob, dim))`` per row:
    0.0 for empty, dimension-mismatched, or zero-norm vectors.
    """
    n = len(blobs)
    scores = np.zeros(n, dtype=np.float64)
    if not query_vec or n == 0:
        return scores
    q = np.asarray(query_vec, dtype=np.float32)
    d = q.shape[0]
    q_norm = float(np.linalg.norm(q.astype(np.float64)))
    if q_norm <= 0:
        return scores
    width = d * 4
    usable = [
        i for i in range(n) if blobs[i] and _blob_dim(blobs[i], dims[i]) == d
    ]
    for start in range(0, len(usable), _SCORE_BATCH_ROWS):
        idx = usable[start : start + _SCORE_BATCH_ROWS]
        # Slice only oversize blobs; slicing every row doubles the copy.
        mat = np.frombuffer(
            b"".join(
                blobs[i] if len(blobs[i]) == width else blobs[i][:width]
                for i in idx
            ),
            dtype=np.float32,
        ).reshape(len(idx), d)
        dots = mat @ q
        norms = np.sqrt(np.einsum("ij,ij->i", mat, mat))
        with np.errstate(divide="ignore", invalid="ignore"):
            part = np.where(norms > 0, dots / (norms * q_norm), 0.0)
        scores[idx] = part
    return scores


def l2_normalize(vec: list[float]) -> list[float]:
    if not vec:
        return []
    norm = sum(x * x for x in vec) ** 0.5
    if norm <= 0:
        return list(vec)
    return [x / norm for x in vec]


def blend_vectors(
    a: list[float], b: list[float], *, weight_a: float = 0.5
) -> list[float]:
    """Weighted average then L2-normalize. ``a`` weight is ``weight_a``, ``b`` is 1-weight_a."""
    if not a:
        return l2_normalize(b)
    if not b or len(a) != len(b):
        return l2_normalize(a)
    w_b = 1.0 - weight_a
    mixed = [weight_a * x + w_b * y for x, y in zip(a, b)]
    return l2_normalize(mixed)


def mean_vectors(vectors: list[list[float]]) -> Optional[list[float]]:
    usable = [v for v in vectors if v]
    if not usable:
        return None
    dim = len(usable[0])
    acc = [0.0] * dim
    n = 0
    for v in usable:
        if len(v) != dim:
            continue
        for i, x in enumerate(v):
            acc[i] += x
        n += 1
    if n <= 0:
        return None
    return [x / float(n) for x in acc]


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


def _embeddings_match_model(
    session: Session, video_id: int, model: str
) -> bool:
    """True when the video has at least one embedding row, all using ``model``."""
    rows = session.exec(
        select(VideoEmbedding).where(VideoEmbedding.video_id == video_id)
    ).all()
    if not rows:
        return False
    return all(str(row.model or "") == model for row in rows)


def embed_video(session: Session, video_id: int) -> bool:
    """Compute and store embeddings for a video.

    Returns True on success. Returns False for soft preconditions (missing video,
    needs_review, no provider). Raises RuntimeError on hard failures (including
    empty corpus).
    """
    video = session.get(Video, video_id)
    if video is None or video.needs_review:
        return False

    provider = get_embed_provider()
    if provider is None:
        return False

    ai = app_settings.ai_settings()
    model = resolve_embed_model(provider)
    use_subs = bool(ai.get("use_subtitles", True))
    digest = ai_text.content_hash(video, use_subtitles=use_subs)
    meta = session.get(VideoAiMeta, video_id)
    if (
        meta is not None
        and meta.content_hash == digest
        and meta.embed_status == "ready"
        and _embeddings_match_model(session, video_id, model)
    ):
        if meta.embed_error:
            meta.embed_error = None
            meta.updated_at = utcnow()
            session.add(meta)
            session.commit()
        return True

    docs = ai_text.documents_for_video(video, use_subtitles=use_subs)
    usable = [(idx, doc) for idx, doc in docs if doc.strip()]

    # OpenRouter records usage on a second Session. An uncommitted DELETE/flush
    # here holds the SQLite write lock across the HTTP call and deadlocks:
    # INSERT INTO openrouter_usage → database is locked → job fails.
    session.commit()

    if not usable:
        meta = _get_or_create_meta(session, video_id)
        meta.embed_status = "error"
        meta.embed_error = "empty_document"
        meta.content_hash = digest
        meta.updated_at = utcnow()
        session.add(meta)
        session.commit()
        raise RuntimeError("empty_document: no usable metadata or subtitle text")

    texts = [doc for _, doc in usable]
    try:
        embed_many = getattr(provider, "embed_many", None)
        if callable(embed_many):
            vectors = embed_many(
                texts, model, usage_kind="embed", video_id=video_id
            )
        else:
            vectors = [
                provider.embed(
                    doc, model, usage_kind="embed", video_id=video_id
                )
                for doc in texts
            ]
        old = session.exec(
            select(VideoEmbedding).where(VideoEmbedding.video_id == video_id)
        ).all()
        for row in old:
            session.delete(row)
        for (chunk_index, _doc), vec in zip(usable, vectors):
            session.add(
                VideoEmbedding(
                    video_id=video_id,
                    chunk_index=chunk_index,
                    model=model,
                    dim=len(vec),
                    vector=pack_vector(vec),
                    content_hash=digest,
                    updated_at=utcnow(),
                )
            )
        meta = _get_or_create_meta(session, video_id)
        meta.embed_status = "ready"
        meta.embed_error = None
        meta.content_hash = digest
        meta.updated_at = utcnow()
        session.add(meta)
        session.commit()
        return True
    except RuntimeError:
        raise
    except Exception as exc:  # noqa: BLE001
        session.rollback()
        meta = _get_or_create_meta(session, video_id)
        meta.embed_status = "error"
        meta.embed_error = str(exc)[:500]
        meta.updated_at = utcnow()
        session.add(meta)
        session.commit()
        raise RuntimeError(str(exc)) from exc


def embed_query(query: str) -> Optional[list[float]]:
    provider = get_embed_provider()
    if provider is None or not query.strip():
        return None
    model = resolve_embed_model(provider)
    try:
        return provider.embed(query.strip(), model, usage_kind="embed")
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
    same = [v for v in vectors if len(v) == dim]
    return (np.sum(np.asarray(same, dtype=np.float64), axis=0) / len(vectors)).tolist()


def similar_video_hits(
    session: Session,
    query_vec: list[float],
    *,
    limit: int = 24,
    exclude_ids: Optional[set[int]] = None,
    min_score: float = 0.15,
) -> list[tuple[int, float, int]]:
    """Return (video_id, score, chunk_index) by best-matching chunk."""
    exclude_ids = exclude_ids or set()
    # Plain columns, not ORM objects: the full table is scanned per search.
    rows = [
        row
        for row in session.exec(
            select(
                VideoEmbedding.video_id,
                VideoEmbedding.chunk_index,
                VideoEmbedding.dim,
                VideoEmbedding.vector,
            )
        ).all()
        if row[0] not in exclude_ids
    ]
    scores = cosine_scores(
        query_vec, [r[3] for r in rows], [r[2] for r in rows]
    )
    best: dict[int, tuple[float, int]] = {}
    for i in np.flatnonzero(scores >= min_score):
        video_id, chunk_index = rows[i][0], rows[i][1]
        score = float(scores[i])
        prev = best.get(video_id)
        if prev is None or score > prev[0]:
            best[video_id] = (score, int(chunk_index))

    ranked = sorted(best.items(), key=lambda kv: kv[1][0], reverse=True)
    return [(vid, sc, chunk) for vid, (sc, chunk) in ranked[:limit]]


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
    return [
        (vid, score)
        for vid, score, _chunk in similar_video_hits(
            session,
            query_vec,
            limit=limit,
            exclude_ids=exclude_ids,
            min_score=min_score,
        )
    ]


def retrieve_video_chunks(
    session: Session,
    video_id: int,
    question: str,
    *,
    top_k: int = 6,
    min_score: float = 0.12,
) -> list[str]:
    """Return top caption/metadata chunk texts for ``question`` on one video.

    Vectors store no text — chunk bodies are re-derived via ``documents_for_video``.
    """
    video = session.get(Video, video_id)
    if video is None:
        return []
    query_vec = embed_query(question)
    if not query_vec:
        return []

    rows = session.exec(
        select(VideoEmbedding).where(VideoEmbedding.video_id == video_id)
    ).all()
    if not rows:
        return []

    all_scores = cosine_scores(
        query_vec, [r.vector for r in rows], [r.dim for r in rows]
    )
    scored: list[tuple[float, int]] = [
        (float(all_scores[i]), int(rows[i].chunk_index))
        for i in np.flatnonzero(all_scores >= min_score)
    ]
    if not scored:
        return []

    scored.sort(key=lambda x: x[0], reverse=True)
    wanted = {idx for _, idx in scored[: max(1, top_k)]}

    ai = app_settings.ai_settings()
    use_subs = bool(ai.get("use_subtitles", True))
    docs = {
        idx: text
        for idx, text in ai_text.documents_for_video(video, use_subtitles=use_subs)
        if text and text.strip()
    }
    # Prefer caption chunks over the metadata doc when both match; keep order
    # by descending score.
    out: list[str] = []
    for _, idx in scored:
        if idx not in wanted:
            continue
        text = docs.get(idx)
        if text and text not in out:
            out.append(text)
        if len(out) >= top_k:
            break
    return out


def build_chat_context(session: Session, video: Video, question: str) -> str:
    """Metadata + RAG caption chunks (or subtitle fallback) for video chat."""
    meta = ai_text.metadata_document(video)
    summary: Optional[str] = None
    if video.id is not None:
        ai_meta = session.get(VideoAiMeta, video.id)
        if ai_meta is not None and ai_meta.summary:
            summary = str(ai_meta.summary).strip() or None

    chunks: list[str] = []
    if video.id is not None:
        chunks = retrieve_video_chunks(session, video.id, question)
    if not chunks:
        chunks = ai_text.chat_fallback_captions(video)

    return ai_text.format_chat_context(
        metadata=meta,
        caption_chunks=chunks,
        summary=summary,
    )


def indexed_count(session: Session) -> tuple[int, int]:
    """Return (indexed_ready, total_library_videos).

    Ready means embed_status is ready and stored vectors use the current embed model.
    """
    ai = app_settings.ai_settings()
    model = resolve_embed_model()
    videos = session.exec(
        select(Video).where(Video.needs_review == False)  # noqa: E712
    ).all()
    total = len(videos)
    ready = 0
    for video in videos:
        if video.id is None:
            continue
        meta = session.get(VideoAiMeta, video.id)
        if meta is None or meta.embed_status != "ready":
            continue
        if _embeddings_match_model(session, video.id, model):
            ready += 1
    return ready, total


def videos_needing_embed(
    session: Session,
    *,
    limit: int = 500,
    exclude_ids: Optional[set[int]] = None,
    skip_empty_document: bool = False,
) -> list[int]:
    ai = app_settings.ai_settings()
    use_subs = bool(ai.get("use_subtitles", True))
    model = resolve_embed_model()
    skip_ids = exclude_ids or set()
    videos = session.exec(
        select(Video).where(Video.needs_review == False)  # noqa: E712
    ).all()
    need: list[int] = []
    for video in videos:
        if video.id is None or video.id in skip_ids:
            continue
        meta = session.get(VideoAiMeta, video.id)
        digest = ai_text.content_hash(video, use_subtitles=use_subs)
        if (
            skip_empty_document
            and meta is not None
            and meta.embed_status == "error"
            and (meta.embed_error or "").startswith("empty_document")
            and meta.content_hash == digest
        ):
            continue
        stale_content = (
            meta is None
            or meta.embed_status != "ready"
            or meta.content_hash != digest
        )
        if stale_content or not _embeddings_match_model(session, video.id, model):
            need.append(video.id)
            if len(need) >= limit:
                break
    return need


def lock_tags_on_manual_edit(session: Session, video_id: int) -> None:
    sync_tag_provenance(session, video_id)


def sync_tag_provenance(
    session: Session,
    video_id: int,
    *,
    user_tag: Optional[str] = None,
) -> None:
    """Lock auto-enrich and keep ai/user tag lists in sync with Video.tags."""
    from .. import library as lib

    meta = _get_or_create_meta(session, video_id)
    meta.tags_locked = True
    video = session.get(Video, video_id)
    if video is None:
        meta.updated_at = utcnow()
        session.add(meta)
        return

    current = lib.parse_tags(video.tags)
    current_lower = {t.lower() for t in current}

    ai = [t for t in lib.parse_tags(meta.ai_tags or "[]") if t.lower() in current_lower]
    user = [t for t in lib.parse_tags(getattr(meta, "user_tags", None) or "[]") if t.lower() in current_lower]

    if user_tag:
        cleaned = user_tag.strip()
        if cleaned and cleaned.lower() in current_lower:
            if cleaned.lower() not in {t.lower() for t in user}:
                user.append(cleaned)
            # User override wins over AI provenance for the same label.
            ai = [t for t in ai if t.lower() != cleaned.lower()]

    meta.ai_tags = lib.dump_tags(ai)
    meta.user_tags = lib.dump_tags(user)
    meta.updated_at = utcnow()
    session.add(meta)
