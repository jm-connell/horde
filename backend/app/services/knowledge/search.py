"""Keyword search over Ask passages (``kb_chunks_fts``).

Queries are built here, never taken from input: every term becomes a quoted FTS5
phrase (a multi-word term such as "for runner" stays a phrase), terms are joined
with OR and ranked by ``bm25`` so passages matching more of them come first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import text
from sqlmodel import Session

_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_MAX_TERMS = 24
# Short words that carry no meaning in a search ("what does he say about the …").
STOPWORDS = frozenset(
    [
        "a",
        "about",
        "above",
        "after",
        "again",
        "all",
        "also",
        "am",
        "an",
        "and",
        "any",
        "are",
        "as",
        "at",
        "be",
        "been",
        "being",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "doing",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "here",
        "hers",
        "him",
        "his",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "just",
        "me",
        "more",
        "most",
        "my",
        "no",
        "nor",
        "not",
        "of",
        "off",
        "on",
        "once",
        "only",
        "or",
        "other",
        "our",
        "out",
        "over",
        "own",
        "said",
        "same",
        "say",
        "says",
        "she",
        "should",
        "so",
        "some",
        "such",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "through",
        "to",
        "too",
        "under",
        "until",
        "up",
        "very",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "whom",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
        "think",
        "thinks",
        "thought",
        "tell",
        "talk",
        "talks",
        "talked",
        "opinion",
    ]
)
# Highlight markers in snippets (control characters never occur in captions).
MARK_START = "\x02"
MARK_END = "\x03"


def _tokens(term: str) -> list[str]:
    return [t.casefold() for t in _WORD.findall(term)]


# Endings stripped from a term's last word, so "fasting" finds "fast",
# "recommended" finds "recommend" and "batteries" finds "battery". The
# FTS5 table has no stemmer; a prefix query on the stem covers the forms.
_SUFFIXES = ("ies", "ing", "ed", "es", "s")
_MIN_STEM = 4


def _stem(word: str) -> str:
    if len(word) < 6:
        return word
    for suffix in _SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= _MIN_STEM:
            return word[: -len(suffix)]
    return word


def match_expression(terms: list[str]) -> str | None:
    """An FTS5 MATCH string ORing ``terms``; None when nothing searchable is left."""
    parts: list[str] = []
    seen: set[str] = set()
    for term in terms:
        tokens = _tokens(term)
        if len(tokens) == 1 and (tokens[0] in STOPWORDS or len(tokens[0]) < 2):
            continue
        if not tokens:
            continue
        last = _stem(tokens[-1])
        phrase = " ".join([*tokens[:-1], last])
        if phrase in seen:
            continue
        seen.add(phrase)
        quoted = f'"{phrase}"'
        # The last word matches its other endings ("dopamine fast*" finds
        # "dopamine fasting"): always for a lone longer word, and for a
        # phrase whose last word was cut to its stem.
        if len(last) >= 4 and (len(tokens) == 1 or last != tokens[-1]):
            quoted += "*"
        parts.append(quoted)
        if len(parts) >= _MAX_TERMS:
            break
    return " OR ".join(parts) if parts else None


def query_terms(query: str) -> list[str]:
    """Terms of a typed query: "quoted phrases" stay together, other words split."""
    phrases = re.findall(r'"([^"]+)"', query or "")
    rest = re.sub(r'"[^"]*"', " ", query or "")
    return phrases + rest.split()


@dataclass
class Hit:
    chunk_id: int
    kb_video_id: int
    kb_channel_id: int
    chunk_index: int
    start_sec: float
    end_sec: float
    snippet: str
    score: float


def search(
    session: Session,
    terms: list[str],
    *,
    channel_ids: list[int] | None,
    limit: int,
    offset: int = 0,
    video_ids: list[int] | None = None,
) -> list[Hit]:
    """Passages matching any term, best first. ``channel_ids`` None = every
    channel; ``video_ids`` keeps the search to those videos."""
    expression = match_expression(terms)
    if expression is None:
        return []
    params: dict[str, object] = {"q": expression, "limit": limit, "offset": offset}
    channel_filter = ""
    if channel_ids is not None:
        if not channel_ids:
            return []
        names = []
        for i, cid in enumerate(channel_ids):
            params[f"c{i}"] = int(cid)
            names.append(f":c{i}")
        channel_filter = f"AND c.kb_channel_id IN ({', '.join(names)})"
    if video_ids is not None:
        if not video_ids:
            return []
        names = []
        for i, vid in enumerate(video_ids):
            params[f"v{i}"] = int(vid)
            names.append(f":v{i}")
        channel_filter += f" AND c.kb_video_id IN ({', '.join(names)})"
    sql = text(
        "SELECT c.id, c.kb_video_id, c.kb_channel_id, c.chunk_index, c.start_sec, "  # noqa: S608 - only bound parameter names are interpolated
        "c.end_sec, snippet(kb_chunks_fts, 0, :ms, :me, '…', 32), "
        "bm25(kb_chunks_fts) AS score "
        "FROM kb_chunks_fts JOIN kb_chunks c ON c.id = kb_chunks_fts.rowid "
        f"WHERE kb_chunks_fts MATCH :q {channel_filter} "
        "ORDER BY score LIMIT :limit OFFSET :offset"
    )
    params["ms"] = MARK_START
    params["me"] = MARK_END
    rows = session.execute(sql, params).all()
    return [
        Hit(
            chunk_id=r[0],
            kb_video_id=r[1],
            kb_channel_id=r[2],
            chunk_index=r[3],
            start_sec=float(r[4]),
            end_sec=float(r[5]),
            snippet=str(r[6] or ""),
            score=float(r[7]),
        )
        for r in rows
    ]


def fts_available(session: Session) -> bool:
    row = session.execute(
        text(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kb_chunks_fts'"
        )
    ).first()
    return row is not None
