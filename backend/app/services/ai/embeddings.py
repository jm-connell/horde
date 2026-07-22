"""SQLite-backed float32 embedding store and cosine similarity helpers."""

from __future__ import annotations

import struct
from typing import Optional

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
    """Compute and store embeddings for a video. Returns True on success."""
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
    meta = _get_or_create_meta(session, video_id)
    if (
        meta.content_hash == digest
        and meta.embed_status == "ready"
        and _embeddings_match_model(session, video_id, model)
    ):
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
        usable = [(idx, doc) for idx, doc in docs if doc.strip()]
        if not usable:
            meta.embed_status = "ready"
            meta.content_hash = digest
            meta.updated_at = utcnow()
            session.add(meta)
            session.commit()
            return True
        texts = [doc for _, doc in usable]
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
        for (chunk_index, _doc), vec in zip(usable, vectors):
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

    scored: list[tuple[float, int]] = []
    for row in rows:
        vec = unpack_vector(row.vector, row.dim)
        score = cosine(query_vec, vec)
        if score < min_score:
            continue
        scored.append((score, int(row.chunk_index)))
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


def videos_needing_embed(session: Session, *, limit: int = 500) -> list[int]:
    ai = app_settings.ai_settings()
    use_subs = bool(ai.get("use_subtitles", True))
    model = resolve_embed_model()
    videos = session.exec(
        select(Video).where(Video.needs_review == False)  # noqa: E712
    ).all()
    need: list[int] = []
    for video in videos:
        if video.id is None:
            continue
        meta = session.get(VideoAiMeta, video.id)
        digest = ai_text.content_hash(video, use_subtitles=use_subs)
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
