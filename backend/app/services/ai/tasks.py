"""AI job runners: embed, enrich tags, score duplicates, refresh categories."""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

from sqlmodel import Session, select

from ...models import AiCategory, AiJobKind, ChannelCatalogEmbedding, ChannelCatalogVideo, Video, VideoAiMeta, utcnow
from .. import app_settings, channel_catalog, library
from . import embeddings, text as ai_text
from .provider import get_provider

logger = logging.getLogger(__name__)


def _parse_json_object(raw: str) -> dict[str, Any]:
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            return {}
        try:
            data = json.loads(match.group(0))
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}


def run_embed_video(session: Session, video_id: Optional[int]) -> None:
    if video_id is None:
        raise RuntimeError("embed_video requires video_id")
    embeddings.embed_video(session, video_id)


def run_embed_catalog_video(
    session: Session, catalog_video_id: Optional[int]
) -> None:
    if catalog_video_id is None:
        raise RuntimeError("embed_catalog_video requires catalog_video_id")
    video = session.get(ChannelCatalogVideo, catalog_video_id)
    if video is None:
        return
    provider = get_provider()
    if provider is None:
        raise RuntimeError("Ollama not available")
    ai = app_settings.ai_settings()
    model = str(ai.get("embed_model") or "nomic-embed-text")
    digest = channel_catalog.catalog_content_hash(video)
    existing = session.exec(
        select(ChannelCatalogEmbedding).where(
            ChannelCatalogEmbedding.catalog_video_id == catalog_video_id
        )
    ).first()
    if existing is not None and existing.content_hash == digest:
        return
    doc = channel_catalog.catalog_document(video)
    if not doc.strip():
        return
    vec = provider.embed(doc, model)
    if existing is None:
        existing = ChannelCatalogEmbedding(catalog_video_id=catalog_video_id)
    existing.model = model
    existing.dim = len(vec)
    existing.vector = embeddings.pack_vector(vec)
    existing.content_hash = digest
    existing.updated_at = utcnow()
    session.add(existing)
    session.commit()


def _tag_norm_key(tag: str) -> str:
    """Normalize for near-duplicate comparison (case + light plural folding)."""
    words = re.sub(r"[^a-z0-9\s]", " ", tag.lower()).split()
    folded: list[str] = []
    for w in words:
        if len(w) > 3 and w.endswith("ies"):
            w = w[:-3] + "y"
        elif len(w) > 3 and w.endswith("ses"):
            w = w[:-2]
        elif len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        folded.append(w)
    return " ".join(folded)


def _is_near_duplicate(tag: str, seen_norms: set[str]) -> bool:
    key = _tag_norm_key(tag)
    if not key:
        return True
    if key in seen_norms:
        return True
    # Token-set equality (order-independent)
    tokens = frozenset(key.split())
    for existing in seen_norms:
        if frozenset(existing.split()) == tokens:
            return True
    return False


def run_enrich_tags(session: Session, video_id: Optional[int]) -> None:
    if video_id is None:
        raise RuntimeError("enrich_tags requires video_id")
    ai = app_settings.ai_settings()
    if not ai.get("enrich_tags", True):
        return

    video = session.get(Video, video_id)
    if video is None or video.needs_review:
        return

    meta = session.get(VideoAiMeta, video_id)
    if meta is not None and meta.tags_locked:
        return

    provider = get_provider()
    if provider is None:
        raise RuntimeError("Ollama not available")
    if not provider.has_model(str(ai.get("chat_model") or "llama3.2:3b")):
        raise RuntimeError("Chat model not available")

    existing = library.parse_tags(video.tags)
    prompt = ai_text.tag_enrich_prompt(video, existing)
    raw = provider.chat(
        prompt,
        str(ai.get("chat_model") or "llama3.2:3b"),
        system=(
            "You are a tagging assistant. Reply with JSON only. "
            "Return as many useful non-duplicate tags as needed (typically 3-12), "
            "not just one."
        ),
    )
    data = _parse_json_object(raw)
    suggested = data.get("tags") if isinstance(data.get("tags"), list) else []
    merged = list(existing)
    seen = {t.lower() for t in existing}
    seen_norms = {_tag_norm_key(t) for t in existing}
    added_ai: list[str] = []
    for tag in suggested:
        if not isinstance(tag, str):
            continue
        cleaned = tag.strip()
        if not cleaned or len(cleaned) > 40:
            continue
        key = cleaned.lower()
        if key in seen or _is_near_duplicate(cleaned, seen_norms):
            continue
        seen.add(key)
        seen_norms.add(_tag_norm_key(cleaned))
        merged.append(cleaned)
        added_ai.append(cleaned)
        if len(merged) >= 24:
            break

    video.tags = library.dump_tags(merged)
    session.add(video)
    if meta is None:
        meta = VideoAiMeta(video_id=video_id)
    prev_ai = library.parse_tags(meta.ai_tags) if meta.ai_tags else []
    prev_seen = {t.lower() for t in prev_ai}
    for tag in added_ai:
        if tag.lower() not in prev_seen:
            prev_ai.append(tag)
            prev_seen.add(tag.lower())
    meta.ai_tags = library.dump_tags(prev_ai)
    meta.tags_enriched_at = utcnow()
    meta.updated_at = utcnow()
    session.add(meta)
    session.commit()


def run_refresh_categories(session: Session, _video_id: Optional[int] = None) -> None:
    provider = get_provider()
    if provider is None:
        raise RuntimeError("Ollama not available")
    ai = app_settings.ai_settings()
    chat_model = str(ai.get("chat_model") or "llama3.2:3b")
    embed_model = str(ai.get("embed_model") or "nomic-embed-text")
    if not provider.has_model(chat_model) or not provider.has_model(embed_model):
        raise RuntimeError("Required models not available")

    from sqlalchemy import nullslast

    videos = session.exec(
        select(Video)
        .where(Video.needs_review == False)  # noqa: E712
        .order_by(nullslast(Video.last_watched_at.desc()), Video.added_at.desc())
        .limit(60)
    ).all()
    titles = [v.title for v in videos if v.title]
    if len(titles) < 3:
        return

    raw = provider.chat(
        ai_text.category_prompt(titles),
        chat_model,
        system="You invent short browse categories. Reply with JSON only.",
    )
    data = _parse_json_object(raw)
    names = data.get("categories") if isinstance(data.get("categories"), list) else []
    cleaned: list[str] = []
    seen: set[str] = set()
    for name in names:
        if not isinstance(name, str):
            continue
        label = " ".join(name.strip().split())
        if not label or len(label) > 24:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(label)
        if len(cleaned) >= 15:
            break
    if not cleaned:
        return

    # Replace category table.
    existing = session.exec(select(AiCategory)).all()
    for row in existing:
        session.delete(row)
    session.flush()

    for name in cleaned:
        vec = provider.embed(name, embed_model)
        session.add(
            AiCategory(
                name=name,
                embedding=embeddings.pack_vector(vec),
                dim=len(vec),
                model=embed_model,
                updated_at=utcnow(),
            )
        )
    session.commit()


def run_score_duplicates(session: Session, _video_id: Optional[int] = None) -> None:
    # Scoring is done on-demand in the review API; this job is a no-op placeholder
    # kept for queue kind completeness / future batch precompute.
    return


def dispatch(
    session: Session,
    kind: AiJobKind,
    video_id: Optional[int],
    *,
    catalog_video_id: Optional[int] = None,
) -> None:
    if kind == AiJobKind.embed_video:
        run_embed_video(session, video_id)
    elif kind == AiJobKind.embed_catalog_video:
        run_embed_catalog_video(session, catalog_video_id)
    elif kind == AiJobKind.enrich_tags:
        run_enrich_tags(session, video_id)
    elif kind == AiJobKind.refresh_categories:
        run_refresh_categories(session, video_id)
    elif kind == AiJobKind.score_duplicates:
        run_score_duplicates(session, video_id)
    else:
        raise RuntimeError(f"Unknown AI job kind: {kind}")
