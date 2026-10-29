"""The Recommended+ gatherer: asks YouTube for videos outside the library.

One worker thread (``DiscoveryRuntime.worker``) serves the users who opened
Recommended+ in the last ``ACTIVE_FOR``, each at most every ``RUN_INTERVAL`` (or
sooner when they ask for a refresh, but not within ``REFRESH_MIN_GAP``). A run
makes at most ``SEARCHES_PER_RUN`` searches built from the user's interests and
``RELATED_PER_RUN`` up next lists of videos they liked, then embeds what it found.

Being a good YouTube citizen comes first:

* every request goes through the global extract gate at background priority, so
  it waits behind anything a person is doing and keeps the gate's spacing;
* calls are ``REQUEST_PAUSE_SEC`` apart, and at most ``HOURLY_REQUEST_CAP``
  an hour for all users together;
* a bot check or rate limit stops gathering for ``BACKOFF_START_SEC``, doubling
  on each repeat up to ``BACKOFF_MAX_SEC``, and a clean run resets it;
* the same search or seed is not asked again within its cooldown.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, delete, select

from ...context import current, get_engine
from ...models import (
    DiscoveryHit,
    DiscoveryState,
    DiscoveryVideo,
    User,
    UserStreamState,
    Video,
    as_utc,
    require_id,
    utcnow,
)
from .. import app_settings
from ..ai import embeddings
from ..ai.provider import get_embed_provider, resolve_embed_model
from ..auth.accounts import AuthUser
from ..workers import BackgroundWorker
from ..ytdlp_common import (
    ERROR_KIND_BOT,
    ERROR_KIND_POT,
    ERROR_KIND_RATE_LIMIT,
    ExtractQueueTimeout,
    classify_ytdlp_error,
)
from ..ytdlp_extract import search_youtube_for_discovery, youtube_up_next
from .feedback import exclusions, forget_old_impressions
from .history import Watch, watches
from .interests import Interest, interests, keyword_queries, llm_queries
from .runtime import DiscoveryRuntime

logger = logging.getLogger(__name__)

STARTUP_DELAY_SEC = 90.0
IDLE_WAIT_SEC = 600.0
RUN_INTERVAL = timedelta(hours=6)
ACTIVE_FOR = timedelta(days=3)
REFRESH_MIN_GAP = timedelta(minutes=20)
SEARCHES_PER_RUN = 4
RELATED_PER_RUN = 3
RESULTS_PER_SEARCH = 20
#: YouTube calls an hour for everyone (a search can be two or three HTTP
#: requests: yt-dlp loads YouTube's config first, and may read a second page).
HOURLY_REQUEST_CAP = 30
#: Pause between the gatherer's calls, so a run is a trickle, not a burst.
REQUEST_PAUSE_SEC = 20.0
ASK_COOLDOWN = timedelta(days=4)
SEED_COOLDOWN = timedelta(days=7)
BACKOFF_START_SEC = 30 * 60.0
BACKOFF_MAX_SEC = 12 * 3600.0
#: Found videos stop being candidates after this; a later run finds new ones.
HIT_TTL = timedelta(days=21)
MAX_HITS_PER_USER = 1500
EMBED_BATCH = 32
_THROTTLE_KINDS = frozenset({ERROR_KIND_BOT, ERROR_KIND_RATE_LIMIT, ERROR_KIND_POT})


def enabled() -> bool:
    """Recommended+ may ask YouTube (its own switch and site-wide video search)."""
    data = app_settings.load()
    return bool(data.get("discovery_enabled", True)) and (
        app_settings.youtube_video_search_system(data)
    )


def _state(session: Session, user_id: int) -> DiscoveryState:
    """The user's row, created if missing (safe when two requests race to it)."""
    row = session.get(DiscoveryState, user_id)
    if row is not None:
        return row
    session.add(DiscoveryState(user_id=user_id))
    try:
        session.commit()
    except IntegrityError:
        session.rollback()  # The other request created it.
    found = session.get(DiscoveryState, user_id)
    if found is None:
        raise RuntimeError(f"discovery_state for user {user_id} vanished")
    return found


def _asked(row: DiscoveryState) -> dict[str, str]:
    try:
        data = json.loads(row.asked_json or "{}")
    except ValueError:
        return {}
    return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}


def note_viewed(
    session: Session, runtime: DiscoveryRuntime, user_id: int
) -> DiscoveryState:
    """The user opened Recommended+: keep gathering for them (start now if never)."""
    row = _state(session, user_id)
    first = row.last_run_at is None and row.requested_at is None
    row.last_viewed_at = utcnow()
    if first:
        row.requested_at = row.last_viewed_at
    session.add(row)
    session.commit()
    session.refresh(row)
    if first:
        runtime.wake()
    return row


def request_refresh(session: Session, runtime: DiscoveryRuntime, user_id: int) -> bool:
    """Ask for a run soon. False when the last one was too recent."""
    row = _state(session, user_id)
    now = utcnow()
    if row.last_run_at is not None and now - as_utc(row.last_run_at) < REFRESH_MIN_GAP:
        return False
    row.requested_at = now
    row.last_viewed_at = now
    session.add(row)
    session.commit()
    runtime.wake()
    return True


def due_users(session: Session, now: datetime) -> list[int]:
    rows = session.exec(
        select(DiscoveryState).where(
            col(DiscoveryState.last_viewed_at) >= now - ACTIVE_FOR
        )
    ).all()
    due: list[tuple[int, datetime, int]] = []
    for row in rows:
        last = as_utc(row.last_run_at)
        requested = as_utc(row.requested_at)
        asked = requested is not None and (last is None or requested > last)
        if asked or last is None or now - last >= RUN_INTERVAL:
            due.append(
                (
                    0 if asked else 1,
                    last or datetime.min.replace(tzinfo=now.tzinfo),
                    row.user_id,
                )
            )
    due.sort()
    return [user_id for _rank, _last, user_id in due]


class _Halt(Exception):
    """Stop this run: out of budget, backing off, or shutting down."""


@dataclass
class _Request:
    kind: str  # search | related
    key: str  # the query, or the seed's YouTube id
    era: str
    this_year: bool = False
    seed_title: str | None = None

    @property
    def asked_key(self) -> str:
        """How ``discovery_state.asked_json`` names it (searches ignore case)."""
        return f"q:{self.key.lower()}" if self.kind == "search" else f"s:{self.key}"


def plan_requests(
    recent: list[Interest],
    dormant: list[Interest],
    history: list[Watch],
    asked: dict[str, str],
    now: datetime,
) -> list[_Request]:
    """This run's searches and up next lists, best first, skipping recent repeats."""

    def fresh(key: str, cooldown: timedelta) -> bool:
        when = asked.get(key)
        if not when:
            return True
        try:
            return now - as_utc(datetime.fromisoformat(when)) >= cooldown
        except ValueError:
            return True

    searches: list[_Request] = []
    # One slot in four for a dormant interest, the rest by weight, round robin.
    throwback = [
        _Request("search", q, "throwback")
        for g in dormant
        for q in g.queries
        if fresh(f"q:{q.lower()}", ASK_COOLDOWN)
    ]
    rounds = max((len(g.queries) for g in recent), default=0)
    recent_qs: list[_Request] = []
    for r in range(rounds):
        for g in recent:
            if r < len(g.queries) and fresh(f"q:{g.queries[r].lower()}", ASK_COOLDOWN):
                # A group's first search looks at this year; the second at any age.
                recent_qs.append(
                    _Request("search", g.queries[r], "recent", this_year=r == 0)
                )
    if throwback:
        searches.append(throwback[0])
    searches.extend(recent_qs[: SEARCHES_PER_RUN - len(searches)])
    if len(searches) < SEARCHES_PER_RUN:
        searches.extend(throwback[1 : 1 + SEARCHES_PER_RUN - len(searches)])

    related: list[_Request] = []
    # Seeds: well-liked YouTube videos, newest first, plus one older favourite.
    liked = [w for w in history if w.yt_id and w.engagement >= 0.7]
    cutoff = now - timedelta(days=60)
    for w in liked:
        if len(related) >= RELATED_PER_RUN - 1:
            break
        if w.watched_at >= cutoff and fresh(f"s:{w.yt_id}", SEED_COOLDOWN):
            related.append(
                _Request("related", str(w.yt_id), "recent", seed_title=w.title)
            )
    old = [w for w in liked if w.watched_at < cutoff and w.finished]
    for w in old:
        if fresh(f"s:{w.yt_id}", SEED_COOLDOWN * 4):
            related.append(
                _Request("related", str(w.yt_id), "throwback", seed_title=w.title)
            )
            break
    for w in liked:
        if len(related) >= RELATED_PER_RUN:
            break
        if all(r.key != w.yt_id for r in related) and fresh(
            f"s:{w.yt_id}", SEED_COOLDOWN
        ):
            related.append(
                _Request("related", str(w.yt_id), "recent", seed_title=w.title)
            )
    # Interleave so a run that halts early still has some of each.
    out: list[_Request] = []
    for i in range(max(len(searches), len(related))):
        out.extend(x[i] for x in (searches, related) if i < len(x))
    return out


def _take_budget(runtime: DiscoveryRuntime) -> None:
    now = time.monotonic()
    if now < runtime.paused_until:
        raise _Halt("backing off")
    runtime.recent_requests = [t for t in runtime.recent_requests if now - t < 3600]
    if len(runtime.recent_requests) >= HOURLY_REQUEST_CAP:
        raise _Halt("hourly cap")
    runtime.recent_requests.append(now)


def _throttled(runtime: DiscoveryRuntime) -> None:
    runtime.backoff_sec = min(
        BACKOFF_MAX_SEC, max(BACKOFF_START_SEC, runtime.backoff_sec * 2)
    )
    runtime.paused_until = time.monotonic() + runtime.backoff_sec
    logger.warning(
        "YouTube pushed back; Recommended+ stops asking for %.0f minutes",
        runtime.backoff_sec / 60,
    )


def store_results(
    session: Session,
    user_id: int,
    request: _Request,
    entries: list[dict[str, Any]],
    *,
    in_library: set[str],
    blocked: Callable[[str, str | None, str | None], bool],
) -> int:
    """Upsert the found videos and this user's hits on them; returns new hits."""
    now = utcnow()
    added = 0
    for rank, entry in enumerate(entries):
        yt_id = str(entry.get("id") or "")
        if not yt_id or yt_id in in_library or yt_id == request.key:
            continue
        if blocked(yt_id, entry.get("channel_url"), entry.get("channel")):
            continue
        row = session.exec(
            select(DiscoveryVideo).where(DiscoveryVideo.yt_id == yt_id)
        ).first()
        if row is None:
            row = DiscoveryVideo(
                yt_id=yt_id, url=f"https://www.youtube.com/watch?v={yt_id}"
            )
        row.title = entry.get("title") or row.title
        row.channel = entry.get("channel") or row.channel
        row.channel_url = entry.get("channel_url") or row.channel_url
        row.duration = entry.get("duration") or row.duration
        row.view_count = entry.get("view_count") or row.view_count
        row.published_at = entry.get("published_at") or row.published_at
        row.published_label = entry.get("published_label") or row.published_label
        row.thumbnail_url = entry.get("thumbnail_url") or row.thumbnail_url
        row.description = entry.get("description") or row.description
        row.live_status = entry.get("live_status")
        session.add(row)
        session.flush()
        row_id = require_id(row)
        hit = session.exec(
            select(DiscoveryHit).where(
                DiscoveryHit.user_id == user_id,
                DiscoveryHit.discovery_video_id == row_id,
                DiscoveryHit.source == request.kind,
            )
        ).first()
        if hit is None:
            hit = DiscoveryHit(
                user_id=user_id, discovery_video_id=row_id, source=request.kind, seed=""
            )
            added += 1
        elif as_utc(hit.found_at) >= now - timedelta(minutes=1) and hit.rank <= rank:
            continue  # Already found better in this run.
        hit.seed = request.key
        hit.seed_title = request.seed_title
        hit.era = request.era
        hit.rank = rank
        hit.found_at = now
        session.add(hit)
    session.commit()
    return added


def _document(row: DiscoveryVideo) -> str:
    parts = [f"Title: {row.title or ''}", f"Channel: {row.channel or ''}"]
    if row.description:
        parts.append("Description: " + row.description[:1000])
    return "\n".join(parts).strip()


def embed_pending(session: Session, *, limit: int = 400) -> int:
    """Embed discovered videos that have no vector for the current model."""
    provider = get_embed_provider()
    if provider is None or app_settings.ai_settings().get("paused"):
        return 0
    model = resolve_embed_model(provider)
    rows = list(
        session.exec(
            select(DiscoveryVideo)
            .where(
                (DiscoveryVideo.embed_dim == 0) | (DiscoveryVideo.embed_model != model)
            )
            .order_by(col(DiscoveryVideo.id).desc())
            .limit(limit)
        ).all()
    )
    done = 0
    for start in range(0, len(rows), EMBED_BATCH):
        batch = [
            r for r in rows[start : start + EMBED_BATCH] if (r.title or "").strip()
        ]
        if not batch:
            continue
        # Usage is recorded on another session: nothing may hold the write lock.
        session.commit()
        try:
            vectors = provider.embed_many(
                [_document(r) for r in batch], model, usage_kind="discovery"
            )
        except Exception:
            logger.warning("could not embed discovered videos", exc_info=True)
            break
        for row, vec in zip(batch, vectors, strict=True):
            row.embed_model = model
            row.embed_dim = len(vec)
            row.vector = embeddings.pack_vector(vec)
            session.add(row)
        session.commit()
        done += len(batch)
    return done


def remember_streams(session: Session, user_id: int, have: set[str]) -> None:
    """Give streamed videos without any vector a row, so they can be embedded."""
    for row in session.exec(
        select(UserStreamState)
        .where(UserStreamState.user_id == user_id)
        .order_by(col(UserStreamState.last_watched_at).desc())
        .limit(200)
    ).all():
        if row.yt_id in have or not row.title:
            continue
        exists = session.exec(
            select(DiscoveryVideo.id).where(DiscoveryVideo.yt_id == row.yt_id)
        ).first()
        if exists is None:
            session.add(
                DiscoveryVideo(
                    yt_id=row.yt_id,
                    url=row.url,
                    title=row.title,
                    channel=row.channel,
                    channel_url=row.channel_url,
                    duration=row.duration_sec,
                )
            )
    session.commit()


def prune(session: Session, user_id: int | None = None) -> None:
    """Forget old hits, cap each user's, and delete videos nothing points at."""
    session.execute(
        delete(DiscoveryHit).where(col(DiscoveryHit.found_at) < utcnow() - HIT_TTL)
    )
    if user_id is not None:
        ids = session.exec(
            select(DiscoveryHit.id)
            .where(DiscoveryHit.user_id == user_id)
            .order_by(col(DiscoveryHit.found_at).desc(), col(DiscoveryHit.id).desc())
            .offset(MAX_HITS_PER_USER)
        ).all()
        if ids:
            session.execute(delete(DiscoveryHit).where(col(DiscoveryHit.id).in_(ids)))
    forget_old_impressions(session)
    referenced = select(DiscoveryHit.discovery_video_id)
    streamed = select(UserStreamState.yt_id)
    session.execute(
        delete(DiscoveryVideo).where(
            col(DiscoveryVideo.id).not_in(referenced),
            col(DiscoveryVideo.yt_id).not_in(streamed),
        )
    )
    session.commit()


def _may_use_ai(session: Session, user_id: int) -> bool:
    """The user's own searches may use the chat model (it can cost money)."""
    user = session.get(User, user_id)
    return user is not None and AuthUser.of(user).can("use_ai")


def gather_for(
    session: Session,
    runtime: DiscoveryRuntime,
    user_id: int,
    stopping: Callable[[], bool] = lambda: False,
    pause: Callable[[float], bool] = lambda _sec: False,
) -> int:
    """One run for one user. Returns how many new candidates it found.

    ``pause(seconds)`` waits between YouTube calls and returns True to stop
    (the worker's sleep); tests pass none.
    """
    now = utcnow()
    state = _state(session, user_id)
    asked = _asked(state)
    history = watches(session, user_id)
    found = 0
    error: str | None = None
    try:
        in_library = {yt for yt in session.exec(select(Video.youtube_id)).all() if yt}
        remember_streams(
            session, user_id, in_library | set(runtime.vectors.matrix(session).index)
        )
        embed_pending(session)
        recent, dormant = interests(session, runtime, history, now)
        groups = recent + dormant
        if not (_may_use_ai(session, user_id) and llm_queries(groups)):
            keyword_queries(session, groups, history)
        excluded = exclusions(session, user_id)
        for n, request in enumerate(
            plan_requests(recent, dormant, history, asked, now)
        ):
            if stopping() or (n and pause(REQUEST_PAUSE_SEC)):
                raise _Halt("stopping")
            _take_budget(runtime)
            try:
                if request.kind == "search":
                    entries = search_youtube_for_discovery(
                        request.key,
                        this_year=request.this_year,
                        limit=RESULTS_PER_SEARCH,
                    )
                else:
                    entries = youtube_up_next(request.key)
            except ExtractQueueTimeout:
                raise _Halt("the extract gate stayed busy") from None
            except Exception as exc:
                kind, message = classify_ytdlp_error(exc)
                if kind in _THROTTLE_KINDS:
                    _throttled(runtime)
                    error = message
                    raise _Halt(message) from exc
                logger.warning(
                    "Recommended+ %s for %r failed",
                    request.kind,
                    request.key,
                    exc_info=True,
                )
                error = message
                continue
            asked[request.asked_key] = now.isoformat()
            found += store_results(
                session,
                user_id,
                request,
                entries,
                in_library=in_library,
                blocked=excluded.blocks,
            )
        runtime.backoff_sec = 0.0
    except _Halt as halt:
        logger.info("Recommended+ run for user %s stopped early: %s", user_id, halt)
    finally:
        session.rollback()
        # The run's record first: a failure below must not make the same
        # searches repeat on the next pass.
        state = _state(session, user_id)
        # Keep only what can still block a repeat.
        horizon = (now - SEED_COOLDOWN * 4).isoformat()
        state.asked_json = json.dumps({k: v for k, v in asked.items() if v >= horizon})
        state.last_run_at = now
        state.last_error = error
        session.add(state)
        session.commit()
        try:
            embed_pending(session)
            prune(session, user_id)
        except Exception:
            session.rollback()
            logger.warning(
                "Recommended+ clean-up for user %s failed", user_id, exc_info=True
            )
        runtime.forget_feeds(user_id)
    return found


def run_due(runtime: DiscoveryRuntime, worker: BackgroundWorker | None = None) -> None:
    if not enabled():
        return
    with Session(get_engine()) as session:
        users = due_users(session, utcnow())
    for n, user_id in enumerate(users):
        if worker is not None and (
            worker.stopping or (n and worker.sleep(REQUEST_PAUSE_SEC))
        ):
            return
        if time.monotonic() < runtime.paused_until:
            return
        runtime.gathering_for = user_id
        try:
            with Session(get_engine()) as session:
                gather_for(
                    session,
                    runtime,
                    user_id,
                    (lambda: worker.stopping)
                    if worker is not None
                    else (lambda: False),
                    worker.sleep if worker is not None else (lambda _sec: False),
                )
        except Exception:
            logger.warning(
                "Recommended+ run for user %s failed", user_id, exc_info=True
            )
        finally:
            runtime.gathering_for = None


def _loop(worker: BackgroundWorker) -> None:
    runtime = current().discovery
    if worker.sleep(STARTUP_DELAY_SEC):
        return
    while not worker.stopping:
        try:
            run_due(runtime, worker)
            with Session(get_engine()) as session:
                prune(session)
        except Exception:
            logger.warning("Recommended+ gathering failed", exc_info=True)
        if worker.wait_for_wake(IDLE_WAIT_SEC):
            return


def create_worker(runtime: DiscoveryRuntime) -> BackgroundWorker:
    runtime.worker = BackgroundWorker("discovery", _loop)
    return runtime.worker
