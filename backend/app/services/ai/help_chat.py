"""Ask about Horde: a chat that answers from Horde's own docs and source.

The image ships the wiki's Markdown and the source it was built from (under
``/app/source``; a checkout uses the repo itself). Each question retrieves the
best-matching sections with a small BM25 index and hands them to the chat
model next to ``docs/features.md``, so answers match the installed version and
work with small local models. Turns are not stored: the client sends the
conversation so far with each question.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
from collections import Counter, defaultdict
from collections.abc import Generator, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from sqlmodel import Session

from ... import context as app_context
from ...context import get_engine
from ...models import utcnow
from . import chat as ai_chat
from .provider import llm_features_allowed

logger = logging.getLogger(__name__)

REPO_URL = "https://github.com/jm-connell/horde"

#: Characters of retrieved excerpts per question (beside the features page).
_CONTEXT_CHARS = 16_000
_MAX_CHUNKS_PER_FILE = 3
_CODE_WINDOW_LINES = 60
_MD_SECTION_CHARS = 2_400
#: Characters of earlier turns sent back to the model, newest kept first.
_HISTORY_CHARS = 16_000
#: Docs answer most questions; code still wins when it matches much better,
#: and is not held back when the question is about the code.
_DOC_BOOST = 1.4
#: Notes for contributors: matched like code, so "how do I" questions reach
#: the user guides first.
_INTERNAL_DOCS = (
    "CHANGELOG.md",
    "docs/adr/",
    "docs/architecture/",
    "docs/design/",
    "docs/development/",
)
# The page the user is on nudges retrieval without outweighing the question.
_PAGE_WEIGHT = 0.3
_PAGE_CHARS = 300
_CODE_WORDS = frozenset(
    {
        "code",
        "source",
        "function",
        "class",
        "module",
        "implement",
        "implemented",
        "implementation",
        "endpoint",
        "route",
        "file",
        "files",
        "python",
        "typescript",
        "react",
        "component",
        "service",
        "def",
    }
)
_K1 = 1.2
_B = 0.75

#: Repo-relative files and directories indexed besides ``backend/app``.
_ROOT_FILES = (
    "README.md",
    "PRODUCT.md",
    "DESIGN.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    ".env.example",
    "docker-compose.yml",
)
_PRIMER = "docs/features.md"

_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "but",
        "by",
        "can",
        "do",
        "does",
        "for",
        "from",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "me",
        "my",
        "of",
        "on",
        "or",
        "so",
        "that",
        "the",
        "then",
        "there",
        "this",
        "to",
        "was",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "you",
        "your",
        "horde",
        "get",
        "set",
        "use",
        "using",
    }
)
#: Words users type for the words the docs use (``4k`` is lost to tokenize),
#: with the weight the doc's word gets. "Upgrade" also means a new Horde
#: version, so its link to re-downloading a video counts for less.
_SYNONYMS: dict[str, tuple[tuple[str, float], ...]] = {
    "res": (("resolution", 1.0),),
    "rez": (("resolution", 1.0),),
    "4k": (("2160", 1.0), ("resolution", 1.0)),
    "2k": (("1440", 1.0), ("resolution", 1.0)),
    "upgrade": (("redownload", 0.5), ("replace", 0.5)),
}
_WORD = re.compile(r"[A-Za-z][A-Za-z0-9_]*|[0-9]{2,}")
_CAMEL = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+")
_HEADING = re.compile(r"^(#{1,3})\s+(.+?)\s*#*\s*$")
_IMAGE_LINE = re.compile(r"^\s*!\[[^\]]*\]\([^)]*\)\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")
#: An attr_list suffix on a heading (``## Disk limits { #disk-limits }``).
_ATTRS = re.compile(r"\s*\{[^}]*\}\s*$")


@dataclass(frozen=True)
class Chunk:
    path: str
    title: str
    text: str
    start_line: int
    end_line: int
    is_doc: bool

    def source(self, ref: str) -> dict[str, str]:
        """Where a reader can open this excerpt (the wiki, else GitHub)."""
        if self.path.startswith("docs/") and self.path.endswith(".md"):
            page = self.path[len("docs/") : -len(".md")]
            if page == "index" or page.endswith("/index"):
                page = page[: -len("index")]
            url = "/wiki/" + (page + "/" if page and not page.endswith("/") else page)
        else:
            url = f"{REPO_URL}/blob/{ref}/{self.path}"
            if not self.is_doc:
                url += f"#L{self.start_line}-L{self.end_line}"
        return {"path": self.path, "title": self.title, "url": url}


def tokenize(text: str) -> list[str]:
    """Lowercase terms; identifiers also yield their camelCase / snake_case parts."""
    out: list[str] = []
    for word in _WORD.findall(text):
        parts = [p for p in _CAMEL.findall(word) if p]
        terms = (
            {word.lower(), *(p.lower() for p in parts)}
            if len(parts) > 1
            else {word.lower()}
        )
        for term in terms:
            if term in _STOPWORDS or len(term) < 2:
                continue
            if len(term) > 4 and term.endswith("s") and not term.endswith("ss"):
                term = term[:-1]
            out.append(term)
    return out


def source_root() -> Path:
    """Where the docs and frontend source live: the image's copy, else the repo."""
    pkg = Path(app_context.__file__).resolve().parent
    shipped = pkg.parent / "source"
    return shipped if shipped.is_dir() else pkg.parent.parent


def _backend_dir() -> Path:
    return Path(app_context.__file__).resolve().parent


def _source_files(root: Path) -> Iterator[tuple[str, Path]]:
    """``(repo-relative path, file)`` for everything the assistant may read."""
    for name in _ROOT_FILES:
        path = root / name
        if path.is_file():
            yield name, path
    docs = root / "docs"
    if docs.is_dir():
        for path in sorted(docs.rglob("*.md")):
            yield f"docs/{path.relative_to(docs).as_posix()}", path
    backend = _backend_dir()
    for path in sorted(backend.rglob("*.py")):
        rel = path.relative_to(backend).as_posix()
        # This module's word lists would match every question.
        if rel.startswith("migrations/") or rel in {
            "legacy_migrations.py",
            "services/ai/help_chat.py",
        }:
            continue
        yield f"backend/app/{rel}", path
    src = root / "frontend" / "src"
    if src.is_dir():
        for path in sorted([*src.rglob("*.ts"), *src.rglob("*.tsx")]):
            rel = path.relative_to(src).as_posix()
            if ".test." in path.name or rel == "api/schema.d.ts":
                continue
            yield f"frontend/src/{rel}", path


def _markdown_chunks(path: str, text: str) -> Iterator[Chunk]:
    lines = text.splitlines()
    page_title = path
    sections: list[tuple[str, int, list[str]]] = []
    heading = ""
    start = 1
    body: list[str] = []
    in_fence = False
    for number, line in enumerate(lines, start=1):
        if _FENCE.match(line):
            in_fence = not in_fence
        # A ``# comment`` in a shell block is not a heading.
        match = None if in_fence else _HEADING.match(line)
        if match:
            if body:
                sections.append((heading, start, body))
            heading = _ATTRS.sub("", match.group(2)).strip()
            if len(match.group(1)) == 1 and page_title == path:
                page_title = heading
            start, body = number, [line]
        elif not _IMAGE_LINE.match(line):
            body.append(line)
    if body:
        sections.append((heading, start, body))
    for heading, start, body in sections:
        title = (
            page_title
            if not heading or heading == page_title
            else (f"{page_title} › {heading}")
        )
        piece: list[str] = []
        size = 0
        piece_start = start
        for offset, line in enumerate(body):
            if size + len(line) > _MD_SECTION_CHARS and piece:
                yield _chunk(path, title, piece, piece_start, is_doc=True)
                piece, size, piece_start = [], 0, start + offset
            piece.append(line)
            size += len(line) + 1
        if "".join(piece).strip():
            yield _chunk(path, title, piece, piece_start, is_doc=True)


def _code_chunks(path: str, text: str) -> Iterator[Chunk]:
    lines = text.splitlines()
    for first in range(0, len(lines), _CODE_WINDOW_LINES):
        window = lines[first : first + _CODE_WINDOW_LINES]
        if "".join(window).strip():
            yield _chunk(path, path, window, first + 1, is_doc=False)


def _chunk(path: str, title: str, lines: list[str], start: int, *, is_doc: bool):
    text = "\n".join(lines).strip("\n")
    return Chunk(path, title, text, start, start + len(lines) - 1, is_doc)


def _chunks_for(path: str, text: str) -> Iterator[Chunk]:
    # Source and config files (.env.example, compose) are cut into line windows.
    if path.endswith(".md"):
        return _markdown_chunks(path, text)
    return _code_chunks(path, text)


@dataclass
class HelpIndex:
    """BM25 over the chunks of the shipped docs and source. Built on first use."""

    root: Path
    chunks: list[Chunk] = field(default_factory=list)
    primer: str = ""
    _postings: dict[str, list[tuple[int, int]]] = field(default_factory=dict)
    _lengths: list[int] = field(default_factory=list)
    _avg_len: float = 1.0
    _built: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def ensure_built(self) -> None:
        with self._lock:
            if not self._built:
                self._build()
                self._built = True

    def _build(self) -> None:
        # Built into locals so a failed build leaves the index empty, not half full.
        postings: dict[str, list[tuple[int, int]]] = defaultdict(list)
        chunks: list[Chunk] = []
        lengths: list[int] = []
        primer = ""
        for rel, path in _source_files(self.root):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                logger.warning("help index: cannot read %s", path, exc_info=True)
                continue
            if rel == _PRIMER:
                primer = "\n".join(
                    line for line in text.splitlines() if not _IMAGE_LINE.match(line)
                ).strip()
            for chunk in _chunks_for(rel, text):
                # The path and heading count as words of the excerpt too.
                terms = Counter(tokenize(f"{chunk.title} {chunk.path} {chunk.text}"))
                index = len(chunks)
                chunks.append(chunk)
                lengths.append(sum(terms.values()))
                for term, count in terms.items():
                    postings[term].append((index, count))
        self.chunks, self._lengths, self.primer = chunks, lengths, primer
        self._postings = dict(postings)
        self._avg_len = (sum(lengths) / len(lengths)) if lengths else 1.0
        logger.info(
            "help index: %d excerpts from %s", len(self.chunks), self.root.as_posix()
        )

    def search(
        self, query: dict[str, float], *, doc_boost: float = _DOC_BOOST, limit: int = 40
    ) -> list[Chunk]:
        """Best chunks for weighted query terms, highest score first."""
        self.ensure_built()
        total = len(self.chunks)
        scores: dict[int, float] = defaultdict(float)
        for term, weight in query.items():
            rows = self._postings.get(term)
            if not rows:
                continue
            idf = math.log(1 + (total - len(rows) + 0.5) / (len(rows) + 0.5))
            for index, count in rows:
                norm = _K1 * (1 - _B + _B * self._lengths[index] / self._avg_len)
                scores[index] += weight * idf * count * (_K1 + 1) / (count + norm)
        for index in scores:
            chunk = self.chunks[index]
            if chunk.is_doc and not chunk.path.startswith(_INTERNAL_DOCS):
                scores[index] *= doc_boost
        best = sorted(scores, key=lambda i: scores[i], reverse=True)[:limit]
        return [self.chunks[i] for i in best]


def help_index() -> HelpIndex:
    """The active context's index (each test context gets its own)."""
    caches = app_context.current().caches
    index: HelpIndex | None = caches.get("help_index")
    if index is None:
        index = caches.setdefault("help_index", HelpIndex(source_root()))
    return index


def query_terms(
    question: str, history: list[dict[str, str]], page: str = ""
) -> dict[str, float]:
    """The question's terms, the previous question's at half weight and the
    page the user is on at less."""
    terms: dict[str, float] = {}
    for term in tokenize(page):
        terms[term] = _PAGE_WEIGHT
    earlier = [m["content"] for m in history if m.get("role") == "user"]
    if earlier:
        for term in tokenize(earlier[-1]):
            terms[term] = 0.5
    for term in tokenize(question):
        terms[term] = 1.0
    for word in re.findall(r"[a-z0-9]+", question.lower()):
        for term, weight in _SYNONYMS.get(word, ()):
            terms[term] = max(terms.get(term, 0.0), weight)
    return terms


def select_excerpts(
    index: HelpIndex, question: str, history: list[dict[str, str]], page: str = ""
) -> list[Chunk]:
    """Top excerpts within the character budget, a few per file at most."""
    picked: list[Chunk] = []
    per_file: Counter[str] = Counter()
    used = 0
    asks_code = bool(_CODE_WORDS & set(_WORD.findall(question.lower())))
    query = query_terms(question, history, page)
    for chunk in index.search(query, doc_boost=1.0 if asks_code else _DOC_BOOST):
        if chunk.path == _PRIMER or per_file[chunk.path] >= _MAX_CHUNKS_PER_FILE:
            continue
        if used + len(chunk.text) > _CONTEXT_CHARS:
            continue
        picked.append(chunk)
        per_file[chunk.path] += 1
        used += len(chunk.text)
    return picked


def trim_history(history: list[dict[str, str]]) -> list[dict[str, str]]:
    """The newest turns within ``_HISTORY_CHARS``, alternating user / assistant.

    The client writes these turns, so their size is capped here. A question
    left unanswered (an error, Stop) is dropped when another user turn follows
    it, since some servers refuse two user turns in a row.
    """
    turns = list(history)
    turns.append({"role": "user", "content": ""})  # the question being asked
    alternating = [
        turn
        for turn, after in zip(turns, turns[1:], strict=False)
        if not (turn["role"] == "user" and after["role"] == "user")
    ]
    kept: list[dict[str, str]] = []
    used = 0
    for turn in reversed(alternating):
        used += len(turn["content"])
        if used > _HISTORY_CHARS:
            break
        kept.append(turn)
    kept.reverse()
    # Start on a question, not on a reply cut from its question.
    while kept and kept[0]["role"] != "user":
        kept.pop(0)
    return kept


def git_ref() -> str:
    """The commit this build came from, for GitHub links (else ``main``)."""
    sha = (os.environ.get("HORDE_GIT_SHA") or "").strip()
    return sha if re.fullmatch(r"[0-9a-f]{7,40}", sha) else "main"


def clean_page(page: str | None) -> str:
    """The client's description of where the user is, as one short line."""
    return " ".join((page or "").split())[:_PAGE_CHARS]


def system_prompt(*, is_admin: bool, page: str = "") -> str:
    version = (os.environ.get("HORDE_VERSION") or "").strip() or "a development build"
    role = (
        "The person asking is this server's administrator: they can change every "
        "setting, manage accounts and edit the server's environment."
        if is_admin
        else "The person asking is a member account, not the administrator: "
        "server-wide settings (AI providers, System, accounts, environment "
        "variables) are the administrator's; say so when an answer needs them."
    )
    return (
        "You are the help assistant built into Horde, a self-hosted video library "
        f"and downloader (this server runs {version}). Answer questions about how "
        "to use, configure, run and troubleshoot Horde, and about how it works.\n"
        f"{role}\n"
        "Answer from the documentation and source excerpts below; they come from "
        "this server's own version. Lead with what to do in the app (for example "
        "Settings → AI → Providers), then the details. Bring in code, file paths "
        "and environment variables when the question is technical or the docs do "
        "not cover it. Cite the files you used by path in backticks, e.g. "
        "`docs/guides/downloads.md`. If the excerpts do not contain the answer, "
        "say so plainly, never invent settings, buttons or variables, and point to "
        f"the wiki (/wiki/) or the GitHub issues ({REPO_URL}/issues). Keep answers "
        "short unless asked for detail, and use Markdown."
        + (
            f'\nThe user is looking at: {page}. "This page" or "here" means '
            "that screen; use it when the question is vague, ignore it otherwise."
            if page
            else ""
        )
    )


def format_context(primer: str, excerpts: list[Chunk]) -> str:
    parts = []
    if primer:
        parts.append(f"Feature overview (docs/features.md):\n{primer}")
    for chunk in excerpts:
        where = (
            chunk.path
            if chunk.is_doc
            else f"{chunk.path} lines {chunk.start_line}-{chunk.end_line}"
        )
        parts.append(f"--- {where} ({chunk.title}) ---\n{chunk.text}")
    if not excerpts:
        parts.append("(No documentation or source matched this question.)")
    return "\n\n".join(parts)


class _HelpChat:
    """``ai_chat.ChatTarget`` whose turns live in the client, not the database."""

    label = "help"
    usage_video_id: int | None = None

    def __init__(
        self, history: list[dict[str, str]], *, is_admin: bool, page: str = ""
    ) -> None:
        self._history = trim_history(history)
        self._is_admin = is_admin
        self._page = page
        self.sources: list[dict[str, str]] | None = None

    def validate(self, session: Session, message: str) -> None:
        allowed, reason = llm_features_allowed()
        if not allowed:
            raise ai_chat.ChatError(reason or "AI is disabled", status_code=409)
        text = (message or "").strip()
        if not text:
            raise ai_chat.ChatError("Message is empty", status_code=400)
        if len(text) > 4000:
            raise ai_chat.ChatError("Message is too long", status_code=400)
        # Build now, while a failure can still be reported as an error event.
        try:
            help_index().ensure_built()
        except Exception as exc:
            logger.warning("help index could not be built", exc_info=True)
            raise ai_chat.ChatError(
                "Horde's help pages could not be loaded", status_code=503
            ) from exc

    def add_message(
        self,
        session: Session,
        *,
        role: str,
        content: str,
        cost: float | None = None,
        model: str | None = None,
    ) -> Any:
        return SimpleNamespace(
            id=None,
            role=role,
            content=content,
            cost=cost,
            model=model,
            created_at=utcnow(),
        )

    def history(self, session: Session) -> list[dict[str, str]]:
        return self._history

    def context(self, session: Session, question: str) -> str | None:
        index = help_index()
        excerpts = select_excerpts(index, question, self._history, self._page)
        ref = git_ref()
        seen: dict[str, dict[str, str]] = {}
        for chunk in excerpts:
            seen.setdefault(chunk.path, chunk.source(ref))
        self.sources = list(seen.values())
        return format_context(index.primer, excerpts)

    def exists(self, session: Session) -> bool:
        return True


def stream_help_events(
    message: str,
    history: list[dict[str, str]],
    user_id: int,
    *,
    is_admin: bool,
    page: str | None = None,
    authorized: ai_chat.Authorized | None = None,
) -> Generator[str]:
    """SSE events for one help turn; a ``sources`` event precedes the reply.

    ``page`` is the client's description of the screen the user is on.
    """
    where = clean_page(page)
    target = _HelpChat(history, is_admin=is_admin, page=where)
    sent_sources = False
    with Session(get_engine()) as session:
        for event in ai_chat.run_chat_turn(
            session,
            target,
            message,
            user_id,
            authorized,
            system_prompt=system_prompt(is_admin=is_admin, page=where),
        ):
            # ``context`` has run once the turn reaches the model.
            if target.sources is not None and not sent_sources:
                sent_sources = True
                payload = {"type": "sources", "sources": target.sources}
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            yield event
