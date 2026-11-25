"""Keeps Recommended ranked in the background, so opening it only reads.

Ranking a feed scores every candidate (``feed.build_feed``): a second or more
on a large library. A first page needs a ranking that is current for the
user's history, and a request used to make it whenever the kept one had lapsed
(``runtime.FEED_CACHE_TTL_SEC``), the server had restarted, the day (and with
it the default seed) had changed, or something had been watched.

One worker looks every ``PASS_SEC`` at the people who opened Recommended most
recently (in the last ``gather.ACTIVE_FOR``) and ranks today's feed for whoever
has no current ranking, or one that is about to lapse. A request for that feed
then finds it (``feed.ranked_feed``); any other seed is still ranked when
asked for.

It holds back in three cases, and a request then ranks for itself as before:

* What the feed depends on changed less than ``QUIET_SEC`` ago. Progress is
  reported every few seconds while a video plays and a bulk download adds a
  video every so often; each puts the ranking out of date, and ranking after
  each would be wasted work beside the playback.
* It ranked (or failed to rank) for this person less than ``MIN_GAP_SEC`` ago.
* The person read a further page of the kept ranking in the last
  ``PAGING_HOLD_SEC``: their next page's offset counts on it staying.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from sqlmodel import Session, col, select

from ...context import current, get_engine
from ...models import DiscoveryState, utcnow
from ..workers import BackgroundWorker
from .categories import feed_categories
from .feed import FeedState, feed_state, kept_feed, rank, today_seed
from .gather import ACTIVE_FOR
from .runtime import FEED_CACHE_SIZE, FEED_CACHE_TTL_SEC, DiscoveryRuntime

logger = logging.getLogger(__name__)

STARTUP_DELAY_SEC = 15.0
PASS_SEC = 10.0
#: A kept ranking is replaced this long before requests would stop using it.
RENEW_EARLY_SEC = 3 * PASS_SEC
#: Longer than the slowest progress report (a stream's, every 30 s).
QUIET_SEC = 45.0
MIN_GAP_SEC = 180.0
PAGING_HOLD_SEC = 120.0
#: After a pass that failed as a whole (the database is busy or gone).
FAILED_PAUSE_SEC = 300.0
#: People ranked ahead, the latest visitors first. Half the kept feeds, so
#: theirs are never pushed out by each other.
MAX_USERS = FEED_CACHE_SIZE // 2


def active_users(session: Session, now: datetime) -> list[int]:
    return list(
        session.exec(
            select(DiscoveryState.user_id)
            .where(col(DiscoveryState.last_viewed_at) >= now - ACTIVE_FOR)
            .order_by(col(DiscoveryState.last_viewed_at).desc())
            .limit(MAX_USERS)
        ).all()
    )


@dataclass
class _Tracked:
    """One person's feed as the passes saw it (times are the warmer's clock)."""

    state: FeedState
    #: None: not seen to change (new here, or since a restart).
    changed_at: float | None = None
    tried_at: float | None = None


class Warmer:
    def __init__(
        self, runtime: DiscoveryRuntime, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.runtime = runtime
        self._clock = clock
        self._tracked: dict[int, _Tracked] = {}

    def run_once(self, stopping: Callable[[], bool] = lambda: False) -> None:
        with Session(get_engine()) as session:
            users = active_users(session, utcnow())
        self._tracked = {u: t for u, t in self._tracked.items() if u in users}
        for user_id in users:
            if stopping():
                return
            # One person's failure must not cost the others their ranking.
            try:
                with Session(get_engine()) as session:
                    due = self._due(session, user_id)
                if due:
                    self._rank(user_id)
            except Exception:
                logger.warning(
                    "Could not rank Recommended ahead for user %s",
                    user_id,
                    exc_info=True,
                )

    def _current(self, state: FeedState) -> bool:
        return (
            kept_feed(self.runtime, state, max_age=FEED_CACHE_TTL_SEC - RENEW_EARLY_SEC)
            is not None
        )

    def _due(self, session: Session, user_id: int) -> bool:
        now = self._clock()
        state = feed_state(session, user_id, today_seed())
        tracked = self._tracked.get(user_id)
        if tracked is None:
            tracked = self._tracked[user_id] = _Tracked(state)
        elif tracked.state != state:
            tracked.state, tracked.changed_at = state, now
        if self._current(state):
            return False
        if tracked.changed_at is not None and now - tracked.changed_at < QUIET_SEC:
            return False
        if tracked.tried_at is not None and now - tracked.tried_at < MIN_GAP_SEC:
            return False
        if self.runtime.paged_within(state.key, PAGING_HOLD_SEC):
            return False
        tracked.tried_at = now
        return True

    def _rank(self, user_id: int) -> None:
        started = time.monotonic()
        with self.runtime.ranking(user_id), Session(get_engine()) as session:
            # A request may have ranked it while this waited for the lock.
            state = feed_state(session, user_id, today_seed())
            if self._current(state):
                return
            feed = rank(session, self.runtime, user_id, state)
            # A first page lists the feed's AI categories: measured here too.
            feed_categories(session, self.runtime, feed)
        logger.debug(
            "Ranked Recommended ahead for user %s in %.1f s",
            user_id,
            time.monotonic() - started,
        )


def _loop(worker: BackgroundWorker) -> None:
    warmer = Warmer(current().discovery)
    pause = STARTUP_DELAY_SEC
    while not worker.sleep(pause):
        pause = PASS_SEC
        try:
            warmer.run_once(lambda: worker.stopping)
        except Exception:
            logger.warning("Ranking Recommended ahead failed", exc_info=True)
            pause = FAILED_PAUSE_SEC


def create_worker() -> BackgroundWorker:
    return BackgroundWorker("discovery-rank", _loop)
