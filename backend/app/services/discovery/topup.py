"""More for a category, when someone reaches the end of it.

A category lists what Horde already knows (``category_feed``). A page request
near the end of that list asks for a top-up (``request``); the gatherer's
worker then runs up to ``TOPUP_REQUESTS`` YouTube requests for that category
(its searches, with and without "this year", then the up next lists of its
watches), embeds what it found and adds the videos that fit to the end of the
kept list (``Browse.append``), so the offsets a visit already read stay good.

The request never waits: it answers ``loading`` (ask again shortly) or
``exhausted`` (nothing more for now). A top-up skips the minimum gap between
a user's refreshes but nothing else: the hourly cap, the pause between calls
and a backoff after YouTube pushed back all apply (``gather``).
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import func
from sqlmodel import Session, col, select

from ...context import get_engine
from ...models import DiscoveryHit, RecCategory, Video, as_utc, utcnow
from ..ytdlp_common import ExtractQueueTimeout, classify_ytdlp_error
from . import category_store, gather, topics, tuning
from .candidates import discovered_candidates
from .category_feed import Browse
from .feedback import exclusions
from .picks import Feed
from .runtime import DiscoveryRuntime, TopUp

logger = logging.getLogger(__name__)

#: YouTube requests one top-up may make.
TOPUP_REQUESTS = 2
#: After a top-up that could ask nothing, or found nothing that fits, the end
#: of that category says "nothing more for now" this long.
EXHAUSTED_FOR_SEC = 30 * 60.0


def _fresh(asked: dict[str, str], key: str, cooldown: timedelta, now: datetime) -> bool:
    when = asked.get(key)
    if not when:
        return True
    try:
        return now - as_utc(datetime.fromisoformat(when)) >= cooldown
    except ValueError:
        return True


def plan(
    row: RecCategory, asked: dict[str, str], now: datetime
) -> list[tuple[str, gather._Request]]:
    """The category's next requests, with the key each is remembered under:
    its searches at any age, the same for this year, then its watches' up next
    lists; none that was asked within its cooldown."""
    out: list[tuple[str, gather._Request]] = []
    found = category_store.queries(row)
    for this_year in (False, True):
        for query in found:
            key = f"{'qy' if this_year else 'q'}:{query.lower()}"
            if _fresh(asked, key, gather.ASK_COOLDOWN, now):
                out.append(
                    (
                        key,
                        gather._Request("search", query, row.era, this_year=this_year),
                    )
                )
    for yt_id, title in category_store.seeds(row):
        key = f"s:{yt_id}"
        if _fresh(asked, key, gather.SEED_COOLDOWN, now):
            out.append(
                (key, gather._Request("related", yt_id, row.era, seed_title=title))
            )
    return out[:TOPUP_REQUESTS]


def request(
    session: Session, runtime: DiscoveryRuntime, user_id: int, category_id: int
) -> Literal["loading", "exhausted"]:
    """Ask for more of a category. ``loading``: it is queued or running;
    ``exhausted``: there is no more to be had for now."""
    worker = runtime.worker
    if (
        worker is None
        or not worker.is_alive
        or not gather.enabled()
        or time.monotonic() < runtime.paused_until
        or not tuning.for_user(session, user_id).use_youtube
    ):
        return "exhausted"
    if runtime.queue_topup((user_id, category_id), time.monotonic()):
        runtime.wake()
        return "loading"
    return "exhausted"


def _ask(runtime: DiscoveryRuntime, req: gather._Request) -> list[dict] | None:
    """The request's results; None when it failed. Raises ``gather._Halt`` when
    YouTube must not be asked now."""
    gather._take_budget(runtime)
    try:
        if req.kind == "search":
            return gather.search_youtube_for_discovery(
                req.key, this_year=req.this_year, limit=gather.RESULTS_PER_SEARCH
            )
        return gather.youtube_up_next(req.key)
    except ExtractQueueTimeout:
        raise gather._Halt("the extract gate stayed busy") from None
    except Exception as exc:
        kind, message = classify_ytdlp_error(exc)
        if kind in gather._THROTTLE_KINDS:
            gather._throttled(runtime)
            raise gather._Halt(message) from exc
        logger.warning(
            "Category top-up %s for %r failed", req.kind, req.key, exc_info=True
        )
        return None


def top_up(
    session: Session,
    runtime: DiscoveryRuntime,
    user_id: int,
    category_id: int,
    stopping: Callable[[], bool] = lambda: False,
    pause: Callable[[float], bool] = lambda _sec: False,
) -> int:
    """One top-up; returns how many videos joined the end of the kept lists."""
    row = session.get(RecCategory, category_id)
    if row is None or row.user_id != user_id:
        return 0
    # Turned off since it was queued.
    if not gather.enabled() or not tuning.for_user(session, user_id).use_youtube:
        return 0
    now = utcnow()
    state = gather._state(session, user_id)
    asked = gather._asked(state)
    requests = plan(row, asked, now)
    if not requests:
        return 0
    before = session.exec(
        select(func.max(col(DiscoveryHit.id))).where(DiscoveryHit.user_id == user_id)
    ).one()
    excluded = exclusions(session, user_id)
    typed = topics.active(session, user_id, now)
    in_library = {yt for yt in session.exec(select(Video.youtube_id)).all() if yt}
    try:
        for n, (key, req) in enumerate(requests):
            if stopping() or (n and pause(gather.REQUEST_PAUSE_SEC)):
                break
            entries = _ask(runtime, req)
            # Failed or not, it is not asked again within its cooldown: a seed
            # whose up next list always fails must not hold up the rest.
            asked[key] = now.isoformat()
            if entries is None:
                continue
            gather.store_results(
                session,
                user_id,
                req,
                entries,
                in_library=in_library,
                blocked=excluded.blocks,
                title_blocked=lambda text: typed.word_block(text) is not None,
            )
    except gather._Halt as halt:
        logger.info("Category top-up for user %s stopped early: %s", user_id, halt)
    session.rollback()
    state = gather._state(session, user_id)
    state.asked_json = json.dumps(asked)
    session.add(state)
    session.commit()
    gather.embed_pending(session)
    found = set(
        session.exec(
            select(DiscoveryHit.discovery_video_id).where(
                DiscoveryHit.user_id == user_id,
                col(DiscoveryHit.id) > (before or 0),
            )
        ).all()
    )
    candidates = [
        c
        for c in discovered_candidates(session, set(), found)
        if not excluded.blocks(c.key, c.channel_url, c.channel)
    ]
    added = 0
    for kept in runtime.feeds_of(user_id):
        feed = kept[1] if isinstance(kept, tuple) and len(kept) == 2 else None
        if isinstance(feed, Feed) and isinstance(feed.browse, Browse):
            added = max(
                added, feed.browse.append(session, runtime, category_id, candidates)
            )
    return added


def run_pending(
    runtime: DiscoveryRuntime,
    stopping: Callable[[], bool] = lambda: False,
    pause: Callable[[float], bool] = lambda _sec: False,
) -> bool:
    """Run the top-ups that were asked for (the gatherer's worker calls this).
    True when any ran: the caller pauses before it asks YouTube again."""
    ran = False
    while not stopping():
        key = runtime.next_topup()
        if key is None:
            return ran
        # The pause between YouTube calls holds between top-ups too.
        if ran and pause(gather.REQUEST_PAUSE_SEC):
            runtime.finish_topup(key, None)
            return ran
        ran = True
        added = 0
        try:
            with Session(get_engine()) as session:
                added = top_up(session, runtime, key[0], key[1], stopping, pause)
        except Exception:
            logger.warning("Category top-up for user %s failed", key[0], exc_info=True)
        finally:
            runtime.finish_topup(
                key, None if added else time.monotonic() + EXHAUSTED_FOR_SEC
            )
    return ran


__all__ = ["TopUp", "plan", "request", "run_pending", "top_up"]
