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


def _category_sample_videos(session: Session, *, limit: int = 100) -> list[Video]:
    """Mix recent watches, recent adds, and channel-stratified fill."""
    from collections import defaultdict
    from sqlalchemy import nullslast

    used: set[int] = set()
    out: list[Video] = []
    watch_cap = 35
    add_cap = 35

    def _take(videos: list[Video], cap: int) -> None:
        for video in videos:
            if len(out) >= limit or cap <= 0:
                return
            if video.id is None or video.id in used:
                continue
            if not (video.title or "").strip():
                continue
            used.add(video.id)
            out.append(video)
            cap -= 1

    watched = session.exec(
        select(Video)
        .where(
            Video.needs_review == False,  # noqa: E712
            Video.last_watched_at.is_not(None),  # type: ignore[attr-defined]
        )
        .order_by(Video.last_watched_at.desc())  # type: ignore[union-attr]
        .limit(watch_cap * 2)
    ).all()
    _take(list(watched), watch_cap)

    recent = session.exec(
        select(Video)
        .where(Video.needs_review == False)  # noqa: E712
        .order_by(nullslast(Video.added_at.desc()))
        .limit(add_cap * 2)
    ).all()
    _take(list(recent), add_cap)

    if len(out) >= limit:
        return out

    rest = session.exec(
        select(Video)
        .where(Video.needs_review == False)  # noqa: E712
        .order_by(nullslast(Video.added_at.desc()))
    ).all()
    by_channel: dict[str, list[Video]] = defaultdict(list)
    for video in rest:
        if video.id is None or video.id in used:
            continue
        if not (video.title or "").strip():
            continue
        key = (video.channel or "").strip() or "(unknown)"
        by_channel[key].append(video)

    channels = sorted(
        by_channel.keys(),
        key=lambda c: (-len(by_channel[c]), c.lower()),
    )
    # Round-robin one video per channel until filled.
    while len(out) < limit:
        progressed = False
        for channel in channels:
            bucket = by_channel[channel]
            while bucket:
                video = bucket.pop(0)
                if video.id is None or video.id in used:
                    continue
                used.add(video.id)
                out.append(video)
                progressed = True
                break
            if len(out) >= limit:
                break
        if not progressed:
            break

    return out


def _parse_category_items(raw_items: list[Any]) -> list[tuple[str, str]]:
    """Normalize LLM category list to (name, blurb) pairs."""
    cleaned: list[tuple[str, str]] = []
    seen: set[str] = set()
    seen_norms: set[str] = set()
    for item in raw_items:
        name = ""
        blurb = ""
        if isinstance(item, str):
            name = item
        elif isinstance(item, dict):
            raw_name = item.get("name")
            if isinstance(raw_name, str):
                name = raw_name
            raw_blurb = item.get("blurb")
            if isinstance(raw_blurb, str):
                blurb = raw_blurb
        else:
            continue
        label = " ".join(name.strip().split())
        if not label or len(label) > 40:
            continue
        key = label.lower()
        if key in seen or _is_near_duplicate(label, seen_norms):
            continue
        about = " ".join(blurb.strip().split())
        if len(about) > 120:
            about = about[:120].rstrip()
        seen.add(key)
        seen_norms.add(_tag_norm_key(label))
        cleaned.append((label, about))
        if len(cleaned) >= 15:
            break
    return cleaned


def run_refresh_categories(session: Session, _video_id: Optional[int] = None) -> None:
    provider = get_provider()
    if provider is None:
        raise RuntimeError("Ollama not available")
    ai = app_settings.ai_settings()
    chat_model = str(ai.get("chat_model") or "llama3.2:3b")
    embed_model = str(ai.get("embed_model") or "nomic-embed-text")
    if not provider.has_model(chat_model) or not provider.has_model(embed_model):
        raise RuntimeError("Required models not available")

    videos = _category_sample_videos(session, limit=100)
    titled = [v for v in videos if (v.title or "").strip()]
    if len(titled) < 3:
        return

    use_subs = bool(ai.get("use_subtitles", True))
    # Sample order is watches → adds → stratified. Reverse before budgeting so
    # trim-from-end drops binge-prone watches first and keeps channel diversity.
    prompt_videos = list(reversed(titled))
    entries = [
        ai_text.category_sample_entry(v, use_subtitles=use_subs)
        for v in prompt_videos
    ]
    entries = ai_text.bound_category_entries(entries)

    raw = provider.chat(
        ai_text.category_prompt(entries),
        chat_model,
        system=ai_text.category_system_prompt(),
    )
    data = _parse_json_object(raw)
    raw_cats = data.get("categories") if isinstance(data.get("categories"), list) else []
    cleaned = _parse_category_items(raw_cats)
    # Need a few solid chips before wiping the existing table.
    if len(cleaned) < 3:
        return

    # Precompute invent-sample centroids for example picking.
    sample_centroids: list[tuple[Video, list[float]]] = []
    for video in titled:
        if video.id is None:
            continue
        cent = embeddings.video_centroid(session, video.id)
        if cent:
            sample_centroids.append((video, cent))

    existing = session.exec(select(AiCategory)).all()
    for row in existing:
        session.delete(row)
    session.flush()

    example_min = 0.28
    for name, blurb in cleaned:
        provisional = ai_text.category_embed_text(name, blurb)
        q = provider.embed(provisional, embed_model)
        ranked: list[tuple[float, Video, list[float]]] = []
        for video, cent in sample_centroids:
            score = embeddings.cosine(q, cent)
            if score >= example_min:
                ranked.append((score, video, cent))
        ranked.sort(key=lambda t: t[0], reverse=True)
        examples = ranked[:5]
        example_titles = [
            (v.title or "").strip() for _, v, _ in examples if (v.title or "").strip()
        ]
        doc = ai_text.category_embed_text(
            name, blurb, example_titles=example_titles
        )
        text_vec = provider.embed(doc, embed_model)
        cent = embeddings.mean_vectors([c for _, _, c in examples])
        if cent is None:
            store_vec = embeddings.l2_normalize(text_vec)
        else:
            store_vec = embeddings.blend_vectors(text_vec, cent, weight_a=0.5)
        session.add(
            AiCategory(
                name=name,
                embedding=embeddings.pack_vector(store_vec),
                dim=len(store_vec),
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
