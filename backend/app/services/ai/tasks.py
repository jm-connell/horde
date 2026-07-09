"""AI job runners: embed, enrich tags, score duplicates, refresh categories."""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

from sqlmodel import Session, select

from ...models import AiCategory, AiJobKind, Video, VideoAiMeta, utcnow
from .. import app_settings, library
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
        system="You are a tagging assistant. Reply with JSON only.",
    )
    data = _parse_json_object(raw)
    suggested = data.get("tags") if isinstance(data.get("tags"), list) else []
    merged = list(existing)
    seen = {t.lower() for t in existing}
    for tag in suggested:
        if not isinstance(tag, str):
            continue
        cleaned = tag.strip()
        if not cleaned or len(cleaned) > 40:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(cleaned)
        if len(merged) >= 24:
            break

    video.tags = library.dump_tags(merged)
    session.add(video)
    if meta is None:
        meta = VideoAiMeta(video_id=video_id)
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


def dispatch(session: Session, kind: AiJobKind, video_id: Optional[int]) -> None:
    if kind == AiJobKind.embed_video:
        run_embed_video(session, video_id)
    elif kind == AiJobKind.enrich_tags:
        run_enrich_tags(session, video_id)
    elif kind == AiJobKind.refresh_categories:
        run_refresh_categories(session, video_id)
    elif kind == AiJobKind.score_duplicates:
        run_score_duplicates(session, video_id)
    else:
        raise RuntimeError(f"Unknown AI job kind: {kind}")
