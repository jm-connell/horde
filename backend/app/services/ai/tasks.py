"""AI job runners: embed, enrich tags, summarize, score duplicates, refresh categories."""

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


def _unescape_json_string(fragment: str) -> str:
    try:
        return json.loads(f'"{fragment}"')
    except json.JSONDecodeError:
        return (
            fragment.replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
            .replace('\\"', '"')
            .replace("\\\\", "\\")
        )


# Keys small chat models sometimes use instead of "summary" (e.g. qwen echoes "system").
_SUMMARY_ALT_KEYS = (
    "summary",
    "text",
    "content",
    "response",
    "message",
    "answer",
    "body",
    "system",
)


def _longest_string_value(data: dict[str, Any]) -> str:
    best = ""
    for value in data.values():
        if isinstance(value, str) and len(value.strip()) > len(best):
            best = value.strip()
    return best


def _extract_summary_text(raw: str) -> str:
    """Pull summary text from model output, including truncated/broken JSON."""
    raw = (raw or "").strip()
    if not raw:
        return ""

    data = _parse_json_object(raw)
    for key in _SUMMARY_ALT_KEYS:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    # Alternate shapes some models use
    paras = data.get("paragraphs")
    if isinstance(paras, list):
        joined = "\n\n".join(
            str(p).strip() for p in paras if isinstance(p, str) and p.strip()
        )
        if joined:
            return joined
    # Any other single / longest string field in a parsed object
    if data:
        fallback = _longest_string_value(data)
        if fallback:
            return fallback

    # Closed string value under a known key (including wrong-key responses)
    for key in _SUMMARY_ALT_KEYS:
        match = re.search(
            rf'"{re.escape(key)}"\s*:\s*"((?:[^"\\]|\\.)*)"',
            raw,
            re.DOTALL,
        )
        if match:
            text = _unescape_json_string(match.group(1)).strip()
            if text:
                return text

    # Truncated mid-string: {"summary"|"system"|...: "partial text...
    for key in _SUMMARY_ALT_KEYS:
        match = re.search(
            rf'"{re.escape(key)}"\s*:\s*"(.*)\Z',
            raw,
            re.DOTALL,
        )
        if match:
            frag = match.group(1)
            # Drop a trailing incomplete escape or closing junk
            frag = re.sub(r'\\(["\\/bfnrtu]?)\Z', "", frag)
            frag = re.sub(r'"\s*\}?\s*\Z', "", frag)
            text = _unescape_json_string(frag).strip()
            if text:
                return text

    # Prose reply (no JSON wrapper)
    if not raw.lstrip().startswith("{"):
        return raw

    return ""


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
    chat_model = str(ai.get("chat_model") or "llama3.2:3b")
    from .provider import require_chat_model

    missing = require_chat_model(provider, chat_model)
    if missing:
        raise RuntimeError(missing)

    existing = library.parse_tags(video.tags)
    prompt = ai_text.tag_enrich_prompt(video, existing)
    raw = provider.chat(
        prompt,
        chat_model,
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


class SummarizeError(Exception):
    """User-facing summarize failure with an HTTP-ish status hint."""

    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def run_summarize(session: Session, video_id: int, *, force: bool = False) -> str:
    ai = app_settings.ai_settings()
    if not ai.get("enabled", True):
        raise SummarizeError("AI is disabled", status_code=400)
    if ai.get("paused"):
        raise SummarizeError("AI is paused", status_code=409)
    if not ai.get("ai_summaries", True):
        raise SummarizeError("AI video summaries are disabled", status_code=400)

    video = session.get(Video, video_id)
    if video is None:
        raise SummarizeError("Video not found", status_code=404)
    if video.needs_review:
        raise SummarizeError("Video is still in review", status_code=400)
    if not ai_text.has_subtitle_text(video):
        raise SummarizeError(
            "Summaries require downloaded subtitles for this video",
            status_code=400,
        )

    meta = session.get(VideoAiMeta, video_id)
    if (
        not force
        and meta is not None
        and meta.summary
        and str(meta.summary).strip()
    ):
        return str(meta.summary).strip()

    provider = get_provider()
    if provider is None:
        raise SummarizeError("Ollama not available", status_code=503)
    chat_model = str(ai.get("chat_model") or "llama3.2:3b")
    from .provider import require_chat_model

    missing = require_chat_model(provider, chat_model)
    if missing:
        raise SummarizeError(missing, status_code=503)

    length = ai_text.normalize_summary_length(ai.get("summary_length"))
    max_chars = ai_text.summary_max_chars(length)
    min_words, max_words = ai_text.summary_word_bounds(length)
    prompt = ai_text.summary_prompt(video, length=length)
    system = ai_text.summary_system_prompt(length)
    num_predict = ai_text.summary_num_predict(length)
    # Longer videos / higher num_predict need more than the default 120s chat timeout.
    _SUMMARIZE_TIMEOUT = 300.0

    raw = ""
    summary = ""
    for attempt in range(2):
        raw = provider.chat(
            prompt,
            chat_model,
            system=system,
            num_predict=num_predict,
            timeout=_SUMMARIZE_TIMEOUT,
        )
        summary = _extract_summary_text(raw)
        if summary:
            break
        logger.warning(
            "summarize empty for video_id=%s length=%s attempt=%s raw_len=%s raw_prefix=%r",
            video_id,
            length,
            attempt + 1,
            len(raw or ""),
            (raw or "")[:240],
        )
    if not summary:
        raise SummarizeError("Model returned an empty summary", status_code=502)

    # Small models often ignore word-count targets; append continuations until
    # we hit min_words (rewrite-in-place fails too often on 3B models).
    words = ai_text.count_words(summary)
    for _cont_i in range(2):
        if words >= min_words:
            break
        need = max(80, min_words - words)
        continue_prompt = ai_text.summary_continue_prompt(
            video, summary, length=length, need_words=need
        )
        cont_raw = provider.chat(
            continue_prompt,
            chat_model,
            system=system,
            num_predict=num_predict,
            timeout=_SUMMARIZE_TIMEOUT,
            temperature=0.5,
        )
        continuation = _extract_summary_text(cont_raw)
        cont_words = ai_text.count_words(continuation)
        if cont_words < 40:
            logger.info(
                "summarize continue too short video_id=%s length=%s "
                "before=%s cont=%s raw_prefix=%r",
                video_id,
                length,
                words,
                cont_words,
                (cont_raw or "")[:200],
            )
            break
        summary = f"{summary.rstrip()}\n\n{continuation.strip()}"
        words = ai_text.count_words(summary)

    cleaned = ai_text.format_summary_paragraphs(summary, length=length)
    # Soft trim when the model overshoots the length setting.
    if ai_text.count_words(cleaned) > max_words:
        cleaned = ai_text.trim_to_max_words(cleaned, max_words)
        cleaned = ai_text.format_summary_paragraphs(cleaned, length=length)
    if len(cleaned) > max_chars:
        cleaned = cleaned[:max_chars].rsplit(" ", 1)[0].strip()
        cleaned = ai_text.format_summary_paragraphs(cleaned, length=length)
    if not cleaned:
        raise SummarizeError("Model returned an empty summary", status_code=502)

    if meta is None:
        meta = VideoAiMeta(video_id=video_id)
    meta.summary = cleaned
    meta.summary_length = length
    meta.updated_at = utcnow()
    session.add(meta)
    session.commit()
    return cleaned


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
    from .provider import ensure_models

    if not provider.has_model(chat_model) or not provider.has_model(embed_model):
        if ai.get("auto_pull_models", True):
            ensure_models(provider)
        raise RuntimeError("Required models not available (pull may be in progress)")

    from . import workload as ai_workload

    runtime = ai_workload.resolve_runtime(ai.get("workload_profile"))
    videos = _category_sample_videos(session, limit=runtime.invent_sample_size)
    titled = [v for v in videos if (v.title or "").strip()]
    if len(titled) < 3:
        return

    use_subs = bool(ai.get("use_subtitles", True))
    # Sample order is watches → adds → stratified. Reverse before budgeting so
    # trim-from-end drops binge-prone watches first and keeps channel diversity.
    prompt_videos = list(reversed(titled))
    entries = [
        ai_text.category_sample_entry(
            v,
            use_subtitles=use_subs,
            desc_chars=runtime.invent_desc_chars,
            sub_chars=runtime.invent_sub_chars,
        )
        for v in prompt_videos
    ]
    entries = ai_text.bound_category_entries(
        entries, budget=runtime.invent_budget_chars
    )

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
                blurb=blurb or None,
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
