"""Tokenize search queries and build AND/OR whole-word match clauses."""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Any, Sequence

from sqlalchemy import and_, or_

_TOKEN_RE = re.compile(r"[a-z0-9]+", re.I)

STOPWORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "to",
        "of",
        "in",
        "on",
        "for",
        "and",
        "or",
        "his",
        "her",
        "their",
        "this",
        "that",
        "with",
        "from",
        "how",
        "why",
        "what",
        "when",
        "where",
        "who",
        "video",
        "episode",
        "watch",
        "youtube",
        "vs",
        "is",
        "it",
        "at",
        "by",
        "as",
        "be",
        "i",
        "my",
        "me",
        "we",
        "you",
        "your",
        "our",
    }
)

_SUFFIXES = ("ing", "ed", "es", "s")
# Don't turn ``car`` into ``caring`` / ``cared``; still allow ``paint`` + ing/ed.
_MIN_INFLECT_STEM = 4


def tokenize_query(query: str) -> list[str]:
    """Significant tokens after stopword filtering.

    If every token is a stopword (or none look like words), keep the raw
    tokens / original string so a query like ``the`` still matches.
    """
    q = query.strip()
    if not q:
        return []
    raw = _TOKEN_RE.findall(q.lower())
    if not raw:
        return [q.lower()]
    kept = [t for t in raw if t not in STOPWORDS and len(t) > 1]
    if kept:
        return kept
    kept_short = [t for t in raw if t not in STOPWORDS]
    if kept_short:
        return kept_short
    return raw


def _stems_of(token: str) -> set[str]:
    stems = {token}
    for suffix in _SUFFIXES:
        if token.endswith(suffix) and len(token) - len(suffix) >= 3:
            stems.add(token[: -len(suffix)])
    return stems


def token_variants(token: str) -> list[str]:
    """Whole-word forms: the token, its stem, and light inflections.

    ``painting`` / ``painted`` / ``paints`` share ``paint``. Short stems such
    as ``car`` only add a plural (``cars``), not ``card`` or ``caring``.
    """
    forms: set[str] = set()
    for stem in _stems_of(token):
        forms.add(stem)
        forms.add(stem + "s")
        if len(stem) >= _MIN_INFLECT_STEM:
            forms.update({stem + "es", stem + "ed", stem + "ing"})
    return sorted(forms, key=len, reverse=True)


def query_allows_semantic(query: str) -> bool:
    """Skip embeddings for tiny queries like ``car``; they rank too loosely."""
    tokens = tokenize_query(query)
    if not tokens:
        return False
    return max(len(t) for t in tokens) >= _MIN_INFLECT_STEM


def query_token_groups(query: str) -> list[list[str]]:
    return [token_variants(t) for t in tokenize_query(query)]


def word_boundary_regexp(variants: Sequence[str]) -> str | None:
    """Case-insensitive whole-word regexp for SQLite REGEXP / Python re."""
    alts = [re.escape(v) for v in variants if v]
    if not alts:
        return None
    return rf"(?i)(?<![a-z0-9])(?:{'|'.join(alts)})(?![a-z0-9])"


@lru_cache(maxsize=256)
def _compiled_word_re(alts: tuple[str, ...]) -> re.Pattern[str] | None:
    pattern = word_boundary_regexp(alts)
    if not pattern:
        return None
    return re.compile(pattern)


def _variants_re(variants: Sequence[str]) -> re.Pattern[str] | None:
    return _compiled_word_re(tuple(variants))


def _field_matches_variants(field: Any, variants: Sequence[str]) -> Any:
    pattern = word_boundary_regexp(variants)
    if not pattern:
        return None
    return field.op("REGEXP")(pattern)


def keyword_match_clause(query: str, *fields: Any) -> Any:
    """AND across tokens; each token is a whole-word (with light inflections)."""
    if not fields:
        return None
    groups = query_token_groups(query)
    if not groups:
        return None
    token_clauses = []
    for variants in groups:
        per_field = [
            c
            for c in (_field_matches_variants(f, variants) for f in fields)
            if c is not None
        ]
        if not per_field:
            continue
        token_clauses.append(
            or_(*per_field) if len(per_field) > 1 else per_field[0]
        )
    if not token_clauses:
        return None
    return and_(*token_clauses) if len(token_clauses) > 1 else token_clauses[0]


def _group_in_hay(hay: str, variants: Sequence[str]) -> bool:
    compiled = _variants_re(variants)
    if compiled is None:
        return False
    return compiled.search(hay) is not None


def phrase_in_hay(hay: str, phrase: str) -> bool:
    """True when the query appears as contiguous whole words (not a substring)."""
    parts = _TOKEN_RE.findall(phrase.lower())
    if not parts:
        return False
    if len(parts) == 1:
        return _group_in_hay(hay, token_variants(parts[0]))
    body = r"\s+".join(re.escape(p) for p in parts)
    return (
        re.search(rf"(?i)(?<![a-z0-9]){body}(?![a-z0-9])", hay) is not None
    )


def query_in_text(query: str, text: str) -> bool:
    """Every query token appears as a whole word (or inflection) in ``text``."""
    groups = query_token_groups(query)
    if not groups or not (text or "").strip():
        return False
    return all(_group_in_hay(text, g) for g in groups)


def keyword_rank_key(
    title: str | None,
    description: str | None,
    query: str,
    position: int = 0,
) -> tuple[int, int, int, int]:
    """Sort key: phrase-in-title, all terms in title, coverage, catalog position."""
    groups = query_token_groups(query)
    title_l = title or ""
    desc_l = description or ""
    q = query.strip()
    phrase_in_title = 0 if q and phrase_in_hay(title_l, q) else 1
    title_hits = sum(1 for g in groups if _group_in_hay(title_l, g))
    desc_hits = sum(1 for g in groups if _group_in_hay(desc_l, g))
    all_in_title = 0 if groups and title_hits == len(groups) else 1
    coverage = -(title_hits * 3 + desc_hits)
    return (phrase_in_title, all_in_title, coverage, position)


_SNIPPET_RADIUS = 50
_SNIPPET_MAX = 120


def snippet_around(
    text: str,
    query: str,
    *,
    radius: int = _SNIPPET_RADIUS,
    max_chars: int = _SNIPPET_MAX,
) -> str:
    compact = re.sub(r"\s+", " ", (text or "").strip())
    if not compact:
        return ""
    best_i = -1
    best_n = 0
    for variants in query_token_groups(query):
        compiled = _variants_re(variants)
        if compiled is None:
            continue
        match = compiled.search(compact)
        if match and (match.end() - match.start()) > best_n:
            best_i = match.start()
            best_n = match.end() - match.start()
    if best_i < 0:
        if len(compact) <= max_chars:
            return compact
        return compact[: max_chars - 1].rstrip() + "…"
    start = max(0, best_i - radius)
    end = min(len(compact), best_i + best_n + radius)
    snippet = compact[start:end].strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(compact):
        snippet = snippet + "…"
    if len(snippet) > max_chars:
        snippet = snippet[: max_chars - 1].rstrip() + "…"
    return snippet


def _field_text(value: str | list[str] | None) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return " ".join(str(v) for v in value if v)
    return str(value)


def explain_keyword_match(
    query: str,
    *,
    title: str | None = None,
    description: str | None = None,
    tags: str | list[str] | None = None,
    notes: str | None = None,
) -> dict[str, Any] | None:
    """Best keyword field that contains query tokens, with a short snippet."""
    groups = query_token_groups(query)
    if not groups:
        return None
    candidates: list[tuple[str, str]] = [
        ("title", _field_text(title)),
        ("description", _field_text(description)),
        ("tags", _field_text(tags)),
        ("notes", _field_text(notes)),
    ]
    best_source = ""
    best_hits = 0
    best_text = ""
    for source, text in candidates:
        hits = sum(1 for g in groups if _group_in_hay(text, g))
        if hits > best_hits:
            best_hits = hits
            best_source = source
            best_text = text
    if best_hits <= 0:
        return None
    snippet = snippet_around(best_text, query)
    return {"source": best_source, "snippet": snippet or None}


def explain_match(
    query: str,
    *,
    title: str | None = None,
    description: str | None = None,
    tags: str | list[str] | None = None,
    notes: str | None = None,
    caption_chunk: str | None = None,
    allow_related: bool = False,
) -> dict[str, Any] | None:
    """Keyword field, else caption snippet, else related-index."""
    keyword = explain_keyword_match(
        query, title=title, description=description, tags=tags, notes=notes
    )
    if keyword:
        return keyword
    caption = (caption_chunk or "").strip()
    if caption and query_in_text(query, caption):
        snippet = snippet_around(caption, query)
        return {"source": "captions", "snippet": snippet or None}
    if allow_related:
        return {"source": "related", "snippet": None}
    return None
