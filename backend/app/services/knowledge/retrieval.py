"""Find the passages that answer a question, across one or more Ask channels.

1. **Expand** the question once with the chat model: spellings and synonyms the
   captions may use ("4Runner", "4 runner", "for runner"), generations, part names.
   A follow-up ("what about its battery?") is rewritten with what it refers to,
   from the conversation so far, and the model says whether the answer depends on
   what is newest. Skipped for small local models (a follow-up is then searched
   together with the question before it); on any failure the question's own
   words are used.
2. **Search each channel** by keyword (FTS5, every passage naming the terms) and by
   meaning (embeddings), merged with reciprocal rank fusion. The videos whose
   title names what the question is about (its subjects: "Odin 3") are searched
   once more by themselves, each subject's separately (a lone one counts double): "its battery life" is answered by
   the battery passage of the Odin 3 review, which need not say "Odin 3", not
   by every review's battery passage. For a question about
   what is current ("the best budget handheld right now"), newer videos count for
   more.
3. **Pick** the best videos and their best passages within a character budget
   shared fairly between the channels, and number them in date order, so the model
   can cite ``[n]`` and notice an opinion that changed over time. A question about
   the channel's newest videos also gets their titles and descriptions.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime

from sqlmodel import Session, col, select

from ...models import KbChannel, KbChunk, KbVideo, Video, require_id
from ..ai.embeddings import embed_query
from ..ai.provider import resolve_embed_model
from . import chunking, routing
from . import search as kb_search
from .vectors import VectorCache, top_chunks

logger = logging.getLogger(__name__)

_RRF_K = 60
_CANDIDATES = 80
_PER_VIDEO = 3
# Passages shorter than this say nothing ("and happy gaming you", the last
# caption line of a video) and only take an excerpt's place.
_MIN_PASSAGE_CHARS = 80
# Passages from a video the question names by its title ("summarize his
# Retroid Pocket Duo in-depth review"): enough to cover the whole video.
_NAMED_PER_VIDEO = 10
_TITLE_WORD = re.compile(r"[^\W_]+")
_EXPAND_TIMEOUT = 45.0
# Videos searched once more because their title names a subject of the question.
_SUBJECT_VIDEOS = 60
# The conversation shown to the expansion: this many messages, each cut to this.
_EXPAND_HISTORY = 4
_EXPAND_HISTORY_CHARS = 600
# A question about what is current: a video's weight halves every this many
# years above a floor (``_boost_recent``).
_RECENT_HALF_LIFE_YEARS = 1.5
_RECENT_FLOOR = 0.45
_UNDATED_SPAN_YEARS = 5.0
_RECENT = re.compile(
    r"\b(latest|newest|recent(ly)?|lately|right now|currently|current|nowadays|"
    r"these days|this year|today|up to date|so far)\b",
    re.IGNORECASE,
)
# A question about the earliest of something ("his first Anbernic review"):
# older videos count for more, and a subject's oldest videos are searched.
_EARLIEST = re.compile(
    r"\b(first|earliest|oldest|originally|initially|back when|when (he|she|they) "
    r"(started|began)|in the beginning|used to)\b",
    re.IGNORECASE,
)
# "What are his latest videos about?": answered from the newest uploads themselves.
_NEWEST_VIDEOS = re.compile(
    r"\b(latest|newest|recent|new|last (few|couple|\d+))( \w+)? "
    r"(videos?|uploads?|reviews?|episodes?)\b"
    r"|\b(uploaded|posted|released|reviewed|covered|made) (lately|recently)\b"
    r"|\bwhat(\'s| is| has| have) (he|she|they|the channel) been "
    r"(up to|doing|covering|reviewing|making|uploading|posting)\b",
    re.IGNORECASE,
)
# Of a video's description under its heading in the prompt.
_ABOUT_CHARS = 300
_NEWEST_COUNT = 10
_NEWEST_CHARS = 500


@dataclass
class Excerpt:
    n: int
    chunk_id: int
    channel_id: int
    channel_name: str
    yt_id: str
    title: str
    published_at: str | None
    start_sec: float
    end_sec: float
    text: str
    is_description: bool
    library_video_id: int | None = None
    kb_video_id: int = 0
    #: How the video's description opens: written by the channel, so it spells
    #: the names the captions garble.
    about: str = ""


@dataclass
class Expansion:
    terms: list[str] = field(default_factory=list)
    search: str = ""
    #: The products, people or works the question is about, as titles spell them.
    subjects: list[str] = field(default_factory=list)
    #: The answer depends on what is newest ("the best one right now").
    recent: bool = False


def asks_recent(question: str) -> bool:
    """ "Right now", "latest", "these days": newer videos should count for more."""
    return bool(_RECENT.search(question or ""))


def asks_earliest(question: str) -> bool:
    """ "His first Anbernic review", "what did he originally think?"."""
    return bool(_EARLIEST.search(question or ""))


def asks_newest_videos(question: str) -> bool:
    """ "What are his latest videos about?": about the newest uploads themselves."""
    return bool(_NEWEST_VIDEOS.search(question or ""))


# A question that leans on the one before it: short, or pointing back at something.
_FOLLOW_UP = re.compile(
    r"\b(it|its|that|those|them|they|their|this|these|one|ones|same|also|instead|"
    r"what about|how about|and the)\b",
    re.IGNORECASE,
)


def search_question(
    question: str, history: list[dict[str, str]], expansion: Expansion
) -> str:
    """What to search for: the question, with the user's previous one in front
    when it is a follow-up the expansion did not rewrite ("what about its
    battery?" alone finds every video about batteries)."""
    if expansion.search or not history:
        return question
    if len(question.split()) > 5 and not _FOLLOW_UP.search(question):
        return question
    asked = [t["content"] for t in history if t.get("role") == "user"]
    return f"{asked[-1]} {question}" if asked else question


def watched_title(
    session: Session, channels: list[KbChannel], yt_id: str | None
) -> str | None:
    """The title of the video the user is watching, when one of ``channels``
    has it (a question from its page about "this" means what it is about)."""
    if not yt_id:
        return None
    title = session.exec(
        select(KbVideo.title).where(
            col(KbVideo.kb_channel_id).in_([require_id(c) for c in channels]),
            KbVideo.yt_id == yt_id,
        )
    ).first()
    return title or None


def _words(text: str) -> list[str]:
    return [w.casefold() for w in _TITLE_WORD.findall(text or "")]


# A channel's branding after its titles ("10 Levels of Nachos | With Babish")
# or a trailing aside ("… (ALL S TIER)"): not what people say.
_TITLE_TAIL = re.compile(r"\s+[|•–—]\s+.*$|\s*[(\[][^()\[\]]*[)\]]\s*$")


def _title_words(title: str) -> list[str]:
    """The words of a title that a question naming it would contain."""
    main = _TITLE_TAIL.sub("", title or "") or title or ""
    return [w for w in _words(main) if w not in kb_search.STOPWORDS]


def named_videos(session: Session, channel: KbChannel, question: str) -> list[str]:
    """YouTube ids of the channel's videos whose title (three words or more,
    without branding after a "|" and small words) is all in the question:
    "summarize his Retroid Pocket Duo in-depth review" or "the 10 levels of
    nachos" is about that one video, not every video of the subject."""
    asked = set(_words(question))
    if len(asked) < 3:
        return []
    out = []
    for yt_id, title in session.exec(
        select(KbVideo.yt_id, KbVideo.title).where(
            KbVideo.kb_channel_id == require_id(channel)
        )
    ).all():
        words = _title_words(title or "")
        if len(words) >= 3 and set(words) <= asked:
            out.append(yt_id)
    return out


def _conversation(history: list[dict[str, str]]) -> str:
    lines = []
    for turn in history[-_EXPAND_HISTORY:]:
        who = "Assistant" if turn.get("role") == "assistant" else "User"
        lines.append(f"{who}: {(turn.get('content') or '')[:_EXPAND_HISTORY_CHARS]}")
    return "\n".join(lines)


def expand(
    provider,
    model: str,
    question: str,
    channel_names: list[str],
    history: list[dict[str, str]] | None = None,
    watching: str | None = None,
) -> Expansion:
    """Spellings and synonyms to search for. Empty on failure (the caller falls back)."""
    system = (
        "You prepare searches over auto-generated YouTube captions. Return JSON "
        '{"terms": [...], "subjects": [...], "search": "...", "recent": '
        'true|false}. "terms": up to 12 short words or '
        "phrases that a video answering the question would say: the key names "
        "and things in the question, with the spellings captions often produce "
        '("4Runner", "4 runner", "for runner"), model generations or year '
        "ranges, part and engine names, and plain synonyms. Leave out the "
        "channel names, filler words and words nearly every video of the "
        'channel would say. "subjects": the specific products, people, places '
        "or works the question is about, written the way a video title would "
        'write them, each with its usual short form ("Retroid Pocket 6", "RP6"); '
        "at most 6, never the channels themselves, and empty when the question "
        "names nothing specific. "
        '"search": the question rewritten as one '
        "plain search sentence. When the question only makes sense with the "
        'conversation before it ("what about its battery?", "and the cheaper '
        'one?"), "terms", "subjects" and "search" name what it refers to; so '
        'do they for "this", "it" or "this device" when the user is watching '
        "a video (what that video is about). "
        '"recent": true only when a newer video would give a better answer '
        "because the subject itself changes over time: products and prices "
        "(what to buy now, the current best), software versions, news. False "
        "for advice that does not age: how to repair, maintain, cook, play or "
        "set something up, the history of something, or a question about one "
        'specific older model ("oil for a 2007 Camry"). When unsure, false.'
    )
    prompt = f"Channels: {', '.join(channel_names)}\n"
    if watching:
        prompt += f'The user is watching: "{watching}"\n'
    if history:
        prompt += f"Conversation so far:\n{_conversation(history)}\n"
    prompt += f"Question: {question}"
    try:
        raw = provider.chat(
            prompt,
            model,
            system=system,
            format="json",
            timeout=_EXPAND_TIMEOUT,
            num_predict=600,
            usage_kind="ask",
            # A thinking model spent the whole budget thinking and the JSON
            # came back cut off, so every search fell back to the bare question.
            think=False,
        )
        data = json.loads(raw)
        raw_terms = data.get("terms") if isinstance(data, dict) else None
        search = data.get("search") if isinstance(data, dict) else None
        recent = data.get("recent") is True if isinstance(data, dict) else False
        raw_subjects = data.get("subjects") if isinstance(data, dict) else None
    except Exception:
        logger.info("Ask: query expansion failed; using the question", exc_info=True)
        return Expansion()
    terms = (
        [str(t).strip() for t in raw_terms if str(t).strip()]
        if isinstance(raw_terms, list)
        else []
    )
    subjects = (
        [str(t).strip() for t in raw_subjects if str(t).strip()]
        if isinstance(raw_subjects, list)
        else []
    )
    return Expansion(
        terms=terms[:12],
        search=str(search or "").strip(),
        subjects=subjects[:6],
        recent=recent,
    )


def _fuse(rankings: list[list[int]]) -> dict[int, float]:
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, chunk_id in enumerate(ranking):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (_RRF_K + rank + 1)
    return scores


def _subject_videos(
    session: Session, channel: KbChannel, subject: str, *, oldest: bool = False
) -> list[int]:
    """The channel's videos whose title names ``subject``, newest first (oldest
    first for a question about the earliest)."""
    if len(subject) < 3:
        return []
    return [
        video_id
        for video_id in session.exec(
            select(KbVideo.id)
            .where(
                KbVideo.kb_channel_id == require_id(channel),
                col(KbVideo.title).icontains(subject, autoescape=True),
            )
            .order_by(col(KbVideo.position).desc() if oldest else col(KbVideo.position))
            .limit(_SUBJECT_VIDEOS)
        ).all()
        if video_id is not None
    ]


def _channel_candidates(
    session: Session,
    cache: VectorCache,
    channel: KbChannel,
    terms: list[str],
    query_vector: list[float] | None,
    model: str,
    subjects: list[str],
    oldest: bool = False,
) -> dict[int, float]:
    channel_id = require_id(channel)
    keyword = [
        h.chunk_id
        for h in kb_search.search(
            session, terms, channel_ids=[channel_id], limit=_CANDIDATES
        )
    ]
    rankings = [keyword]
    # One ranking per subject, so in "X vs Y" the side with fewer videos is not
    # crowded out by the other's; a lone subject counts twice.
    within = [
        [
            h.chunk_id
            for h in kb_search.search(
                session,
                terms,
                channel_ids=[channel_id],
                limit=_CANDIDATES,
                video_ids=about,
            )
        ]
        for about in (
            _subject_videos(session, channel, s, oldest=oldest) for s in subjects
        )
        if about
    ]
    rankings += within * 2 if len(within) == 1 else within
    if query_vector:
        rankings.append(
            [
                c
                for c, _ in top_chunks(
                    session, cache, channel, query_vector, _CANDIDATES, model=model
                )
            ]
        )
    return _fuse(rankings)


def _pick(
    session: Session,
    channel: KbChannel,
    scores: dict[int, float],
    budget: int,
    wide: frozenset[str] = frozenset(),
) -> list[tuple[KbChunk, KbVideo]]:
    """Best videos first; per video its best non-overlapping passages, within
    budget. Videos in ``wide`` (by YouTube id) may give more passages."""
    if not scores:
        return []
    chunks = {
        c.id: c
        for c in session.exec(
            select(KbChunk).where(col(KbChunk.id).in_(list(scores)))
        ).all()
    }
    by_video: dict[int, list[KbChunk]] = {}
    for chunk_id in sorted(scores, key=lambda c: -scores[c]):
        chunk = chunks.get(chunk_id)
        if chunk is not None:
            by_video.setdefault(chunk.kb_video_id, []).append(chunk)

    def video_score(video_id: int) -> float:
        hits = by_video[video_id]
        return scores[hits[0].id or 0] + 0.25 * sum(scores[h.id or 0] for h in hits[1:])

    videos = {
        v.id: v
        for v in session.exec(
            select(KbVideo).where(col(KbVideo.id).in_(list(by_video)))
        ).all()
    }
    picked: list[tuple[KbChunk, KbVideo]] = []
    used = 0
    for video_id in sorted(by_video, key=video_score, reverse=True):
        video = videos.get(video_id)
        if video is None:
            continue
        kept: list[KbChunk] = []
        for chunk in by_video[video_id]:
            if len(kept) >= (_NAMED_PER_VIDEO if video.yt_id in wide else _PER_VIDEO):
                break
            if (
                len(chunk.text) < _MIN_PASSAGE_CHARS
                and chunk.chunk_index != chunking.META_CHUNK_INDEX
            ):
                # A title and description are kept however short: for a
                # video without captions they are all there is.
                continue
            if any(
                chunk.start_sec < k.end_sec and k.start_sec < chunk.end_sec
                for k in kept
                if k.chunk_index >= 0 and chunk.chunk_index >= 0
            ):
                continue
            if used + len(chunk.text) > budget and picked:
                break
            kept.append(chunk)
            used += len(chunk.text)
        picked.extend((c, video) for c in kept)
        if used >= budget:
            break
    return picked


# Above any fused score (at most about 2 / (k + 1)): the watched video's
# matching passages come first.
_FOCUS_BOOST = 0.05


def _boost_video(
    session: Session, scores: dict[int, float], channel: KbChannel, yt_id: str
) -> None:
    if not scores:
        return
    focus = set(
        session.exec(
            select(KbChunk.id)
            .join(KbVideo, col(KbVideo.id) == col(KbChunk.kb_video_id))
            .where(
                KbVideo.kb_channel_id == require_id(channel),
                KbVideo.yt_id == yt_id,
                col(KbChunk.id).in_(list(scores)),
            )
        ).all()
    )
    for chunk_id in focus:
        if chunk_id is not None:
            scores[chunk_id] += _FOCUS_BOOST


def _boost_recent(
    session: Session,
    scores: dict[int, float],
    channel: KbChannel,
    *,
    earliest: bool = False,
) -> None:
    """Weigh each passage by how old its video is: a video from this month
    counts in full, one from a year ago about four fifths, three years about
    seven tenths, never less than ``_RECENT_FLOOR``. Only for a question whose
    answer changes over time (``Expansion.recent``, or "right now"): advice
    that does not age is never weighed by date. A gentler, rank-based lift let a
    channel's many older videos outvote its newest roundup for "what would
    he recommend?". A video without a date is placed by its rank among the
    channel's uploads (``KbVideo.position``, 0 = newest). With ``earliest``
    it runs the other way: the channel's oldest video counts in full."""
    if not scores:
        return
    channel_id = require_id(channel)
    last = session.exec(
        select(KbVideo.position)
        .where(KbVideo.kb_channel_id == channel_id)
        .order_by(col(KbVideo.position).desc())
        .limit(1)
    ).first()
    rows = session.exec(
        select(KbChunk.id, KbVideo.position, KbVideo.published_at)
        .join(KbVideo, col(KbVideo.id) == col(KbChunk.kb_video_id))
        .where(col(KbChunk.id).in_(list(scores)))
    ).all()
    today = datetime.now(UTC).date()
    first = None
    if earliest:
        oldest = session.exec(
            select(KbVideo.published_at)
            .where(
                KbVideo.kb_channel_id == channel_id,
                col(KbVideo.published_at).is_not(None),
            )
            .order_by(col(KbVideo.published_at))
            .limit(1)
        ).first()
        first = _age_years(oldest, today)
    for chunk_id, position, published in rows:
        if chunk_id is None:
            continue
        age = _age_years(published, today)
        if age is None:
            # Undated: as old as its share of the channel's uploads, over
            # an assumed _UNDATED_SPAN_YEARS.
            age = _UNDATED_SPAN_YEARS * (min(position, last) / last if last else 0.0)
        if earliest:
            # Years after the channel's first video, not before today.
            age = max(0.0, (first if first is not None else _UNDATED_SPAN_YEARS) - age)
        scores[chunk_id] *= _RECENT_FLOOR + (1 - _RECENT_FLOOR) * 0.5 ** (
            age / _RECENT_HALF_LIFE_YEARS
        )


def _age_years(published: str | None, today: date) -> float | None:
    try:
        day = date.fromisoformat((published or "")[:10])
    except ValueError:
        return None
    return max(0.0, (today - day).days / 365.25)


def _newest_videos(
    session: Session, channel: KbChannel, count: int
) -> list[tuple[KbChunk, KbVideo]]:
    """The title-and-description passages of the channel's newest indexed videos."""
    rows = session.exec(
        select(KbChunk, KbVideo)
        .join(KbVideo, col(KbVideo.id) == col(KbChunk.kb_video_id))
        .where(
            KbVideo.kb_channel_id == require_id(channel),
            KbChunk.chunk_index == chunking.META_CHUNK_INDEX,
        )
        .order_by(col(KbVideo.position))
        .limit(count)
    ).all()
    return [(chunk, video) for chunk, video in rows]


def retrieve(
    session: Session,
    cache: VectorCache,
    channels: list[KbChannel],
    question: str,
    expansion: Expansion,
    *,
    budget_chars: int,
    focus_yt_id: str | None = None,
) -> list[Excerpt]:
    """Numbered excerpts for ``question`` from ``channels``, oldest first.

    ``focus_yt_id`` is the video being watched: its matching passages rank first.
    """
    terms = expansion.terms + kb_search.query_terms(question)
    query_vector = embed_query(expansion.search or question)
    # Only vectors from the current model compare with the query's.
    model = resolve_embed_model()
    share = max(2000, budget_chars // max(1, len(channels)))
    # A channel's own name is not a subject: its title matches are the
    # channel talking about itself (a Discord invite, a studio tour).
    subjects = [
        subject
        for subject in expansion.subjects
        if not any(
            routing.names_channel(subject, c.channel_name, c.channel_url)
            for c in channels
        )
    ]
    earliest = asks_earliest(question)
    recent = (expansion.recent or asks_recent(question)) and not earliest
    newest = asks_newest_videos(question)
    picked: list[tuple[KbChannel, KbChunk, KbVideo]] = []
    # Passages shown cut short (a newest video's description), by chunk id.
    cut: set[int] = set()
    for channel in channels:
        scores = _channel_candidates(
            session,
            cache,
            channel,
            terms,
            query_vector,
            model,
            subjects,
            oldest=earliest,
        )
        if recent or newest or earliest:
            _boost_recent(session, scores, channel, earliest=earliest)
        if focus_yt_id:
            _boost_video(session, scores, channel, focus_yt_id)
        named = frozenset(named_videos(session, channel, question))
        for yt_id in named:
            _boost_video(session, scores, channel, yt_id)
        left = share
        if newest:
            latest = _newest_videos(
                session, channel, max(3, _NEWEST_COUNT // len(channels))
            )
            for chunk, video in latest:
                scores.pop(require_id(chunk), None)
                cut.add(require_id(chunk))
                picked.append((channel, chunk, video))
            left = max(0, share - _NEWEST_CHARS * len(latest))
        if left:
            picked.extend(
                (channel, c, v) for c, v in _pick(session, channel, scores, left, named)
            )
    yt_ids = {v.yt_id for _, _, v in picked}
    library = {
        yt: vid
        for vid, yt in session.exec(
            select(Video.id, Video.youtube_id).where(col(Video.youtube_id).in_(yt_ids))
        ).all()
    }
    picked.sort(key=lambda p: (p[2].published_at or "", p[2].yt_id, p[1].start_sec))
    return [
        Excerpt(
            n=i + 1,
            chunk_id=chunk.id or 0,
            channel_id=channel.id or 0,
            channel_name=channel.channel_name or channel.channel_url,
            yt_id=video.yt_id,
            title=video.title or video.yt_id,
            published_at=video.published_at,
            start_sec=chunk.start_sec,
            end_sec=chunk.end_sec,
            text=chunk.text[:_NEWEST_CHARS] if chunk.id in cut else chunk.text,
            is_description=chunk.chunk_index == chunking.META_CHUNK_INDEX,
            library_video_id=library.get(video.yt_id),
            kb_video_id=video.id or 0,
            about=_opening(video.description),
        )
        for i, (channel, chunk, video) in enumerate(picked)
    ]


def _opening(description: str | None) -> str:
    """The description's first paragraph (what the video is about), cut short;
    the links and credits that follow are left out."""
    first = (description or "").strip().split("\n\n", 1)[0]
    text = " ".join(first.split())
    return text if len(text) <= _ABOUT_CHARS else text[:_ABOUT_CHARS].rstrip() + "…"


def format_excerpts(excerpts: list[Excerpt]) -> str:
    """Excerpts for the prompt, under a heading per video (its channel, title,
    date and how its description opens), so each passage is read as that
    video's: captions rarely repeat what is being reviewed, and garble its
    name when they do. No times: the model cites numbers, the app adds times.
    """
    lines = []
    video: tuple[int, str] | None = None
    for e in excerpts:
        if (e.channel_id, e.yt_id) != video:
            video = (e.channel_id, e.yt_id)
            date = (e.published_at or "")[:10] or "undated"
            head = f'=== {e.channel_name} · "{e.title}" · {date} ==='
            if e.about and not e.is_description:
                head += f"\nThe channel's description of this video: {e.about}"
            lines.append(head)
        kind = "(the video's description) " if e.is_description else ""
        lines.append(f"[{e.n}] {kind}{e.text}")
    return "\n\n".join(lines)
