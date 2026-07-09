"""AI-assisted duplicate confirmation for heuristic review groups."""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from sqlmodel import Session

from ...models import Video
from .. import app_settings
from . import embeddings, text as ai_text
from .provider import get_provider


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


def score_pair(session: Session, a: Video, b: Video) -> dict[str, Any]:
    """Return ai_score / ai_verdict for a candidate duplicate pair."""
    result: dict[str, Any] = {
        "ai_score": None,
        "ai_verdict": None,
        "ai_confidence": None,
        "ai_reason": None,
    }
    ai = app_settings.ai_settings()
    if not ai.get("ai_duplicates", True):
        return result
    provider = get_provider()
    if provider is None:
        return result

    # Embedding similarity as a fast signal.
    embed_score: Optional[float] = None
    if a.id is not None and b.id is not None:
        va = embeddings.video_centroid(session, a.id)
        vb = embeddings.video_centroid(session, b.id)
        if va and vb:
            embed_score = embeddings.cosine(va, vb)
            result["ai_score"] = round(float(embed_score), 4)

    chat_model = str(ai.get("chat_model") or "llama3.2:3b")
    # Only ask the LLM on borderline pairs (or when no embeddings).
    borderline = embed_score is None or 0.35 <= embed_score <= 0.92
    if not borderline or not provider.has_model(chat_model):
        if embed_score is not None:
            if embed_score >= 0.88:
                result["ai_verdict"] = "same"
                result["ai_confidence"] = round(float(embed_score), 3)
            elif embed_score >= 0.55:
                result["ai_verdict"] = "similar"
                result["ai_confidence"] = round(float(embed_score), 3)
            else:
                result["ai_verdict"] = "different"
                result["ai_confidence"] = round(1.0 - float(embed_score), 3)
        return result

    try:
        raw = provider.chat(
            ai_text.duplicate_prompt(a, b),
            chat_model,
            system="You compare archived videos for duplicates. Reply with JSON only.",
        )
        data = _parse_json_object(raw)
        verdict = str(data.get("verdict") or "").lower().strip()
        if verdict in ("same", "similar", "different"):
            result["ai_verdict"] = verdict
        conf = data.get("confidence")
        if isinstance(conf, (int, float)):
            result["ai_confidence"] = round(max(0.0, min(1.0, float(conf))), 3)
        reason = data.get("reason")
        if isinstance(reason, str):
            result["ai_reason"] = reason[:200]
        if result["ai_score"] is None and result["ai_confidence"] is not None:
            result["ai_score"] = result["ai_confidence"]
    except Exception:  # noqa: BLE001
        pass
    return result


def annotate_group(session: Session, videos: list[Video]) -> dict[str, Any]:
    """Score the first pair in a heuristic group (representative)."""
    if len(videos) < 2:
        return {
            "ai_score": None,
            "ai_verdict": None,
            "ai_confidence": None,
            "ai_reason": None,
        }
    return score_pair(session, videos[0], videos[1])
