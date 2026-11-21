"""Which Ask channels can answer a question that names none.

"How much protein should I eat?" asked from the home page names no channel,
so routing by words alone sends it to Horde, which cannot answer it. Here the
channels whose passages are closest in meaning (embeddings) are shortlisted,
and the chat model, shown their names, the titles of their videos that
matched and their newest titles, picks the ones whose
videos would answer it, or none ("what is the capital of Australia?", "tell
me a joke"). Similarity alone is not enough: its scale differs from one
embedding model to the next, so no fixed threshold works for every setup, and
a travel video lands close to a geography question.

Best effort: without a chat model, with a small one, or on any failure the
question goes to Horde as before.
"""

from __future__ import annotations

import json
import logging

from sqlmodel import Session, col, select

from ...context import current
from ...models import KbChannel, KbChunk, KbVideo, require_id
from ..ai import help_model
from ..ai.embeddings import embed_query
from ..ai.provider import get_llm_provider, llm_features_allowed, resolve_embed_model
from . import search as kb_search
from .vectors import top_chunks

logger = logging.getLogger(__name__)

#: Channels shown to the model.
SHORTLIST = 3
#: Titles shown per channel: of the videos that matched the question best,
#: then the newest (what the channel is about).
MATCHED_TITLES = 8
NEWEST_TITLES = 6
#: Passages whose videos are looked at per channel.
_MATCHES = 30
_TIMEOUT = 20.0

_SYSTEM = (
    "You decide which YouTube channels' videos would answer a user's "
    "question. Each channel is listed with the titles of its videos that "
    "match the question best, then its newest. Return "
    'JSON {"channels": [...]} with the exact names of the one or two channels '
    "whose videos would very likely contain the answer, or [] when none "
    "would: general knowledge, arithmetic, chit-chat, writing tasks, a "
    "question about the app itself, or a subject the channels only brush "
    "against. When unsure, return []."
)


def _shortlist(
    session: Session, question: str, channels: list[KbChannel]
) -> list[tuple[KbChannel, list[int]]]:
    """The channels closest to the question, each with its videos that matched
    best: by meaning (embeddings), else by keyword hits."""
    vector = embed_query(question)
    model = resolve_embed_model()
    if vector:
        cache = current().knowledge.vectors
        scored = []
        for channel in channels:
            top = top_chunks(session, cache, channel, vector, _MATCHES, model=model)
            if top:
                scored.append((top[0][1], channel, [chunk_id for chunk_id, _ in top]))
        if scored:
            scored.sort(key=lambda row: -row[0])
            return [
                (channel, _videos_of(session, chunk_ids))
                for _, channel, chunk_ids in scored[:SHORTLIST]
            ]
    hits = kb_search.search(
        session,
        kb_search.query_terms(question),
        channel_ids=[require_id(c) for c in channels],
        limit=200,
    )
    by_channel: dict[int, list[int]] = {}
    for hit in hits:
        by_channel.setdefault(hit.kb_channel_id, []).append(hit.kb_video_id)
    ranked = sorted(
        (c for c in channels if by_channel.get(require_id(c))),
        key=lambda c: -len(by_channel[require_id(c)]),
    )
    return [
        (c, list(dict.fromkeys(by_channel[require_id(c)]))) for c in ranked[:SHORTLIST]
    ]


def _videos_of(session: Session, chunk_ids: list[int]) -> list[int]:
    """The videos of these passages, in the passages' order, each once."""
    video_of = dict(
        session.exec(
            select(KbChunk.id, KbChunk.kb_video_id).where(
                col(KbChunk.id).in_(chunk_ids)
            )
        ).all()
    )
    return list(dict.fromkeys(video_of[c] for c in chunk_ids if c in video_of))


def _titles(session: Session, channel: KbChannel, matched: list[int]) -> list[str]:
    """Titles of the videos that matched the question, then the newest ones
    (what the channel is about these days)."""
    ids = matched[:MATCHED_TITLES]
    found = {
        v.id: v.title
        for v in session.exec(select(KbVideo).where(col(KbVideo.id).in_(ids))).all()
        if v.title
    }
    newest = session.exec(
        select(KbVideo.title)
        .where(KbVideo.kb_channel_id == require_id(channel))
        .order_by(col(KbVideo.position))
        .limit(NEWEST_TITLES)
    ).all()
    titles = [found[i] for i in ids if i in found] + [t for t in newest if t]
    return list(dict.fromkeys(titles))


def enabled() -> bool:
    """Whether unnamed questions are matched to channels at all (a chat model
    that is not small; a small one is too unreliable to send a question away
    from Horde)."""
    if not llm_features_allowed()[0] or get_llm_provider() is None:
        return False
    return help_model.tier(help_model.configured_model()) != "small"


def guess(
    session: Session, question: str, channels: list[KbChannel]
) -> list[KbChannel]:
    """The channels that would answer ``question``; [] when none clearly would."""
    if not channels or not llm_features_allowed()[0]:
        return []
    provider = get_llm_provider()
    if provider is None:
        return []
    model = help_model.assistant_model()
    if help_model.tier(model) == "small":
        return []  # too unreliable to send a question away from Horde
    try:
        shortlist = _shortlist(session, question, channels)
        if not shortlist:
            return []
        listing = "\n\n".join(
            f"{c.channel_name or c.channel_url}:\n"
            + "\n".join(f"- {t}" for t in _titles(session, c, matched))
            for c, matched in shortlist
        )
        raw = provider.chat(
            f"Channels:\n\n{listing}\n\nQuestion: {question}",
            model,
            system=_SYSTEM,
            format="json",
            num_predict=120,
            timeout=_TIMEOUT,
            usage_kind="ask_route",
            think=False,
            # The same question goes to the same place every time.
            temperature=0.0,
        )
        data = json.loads(raw)
        names = data.get("channels") if isinstance(data, dict) else None
    except Exception:
        logger.warning("Ask: guessing the channel for a question failed", exc_info=True)
        return []
    if not isinstance(names, list):
        return []
    wanted = {str(n).strip().casefold() for n in names}
    return [c for c, _ in shortlist if (c.channel_name or "").casefold() in wanted]
