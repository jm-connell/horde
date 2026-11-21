"""Add the channels people already subscribe to to Ask, once.

Subscribing turns Ask on for the channel (``channels.index_on_subscribe``).
Subscriptions older than that, and those to channels that were once too large
to index without a confirm, are added here the first time the Ask worker
starts; ``ask_subscriptions_indexed`` in the app settings records that it ran,
so a channel someone turns Ask off for afterwards stays off.
"""

from __future__ import annotations

import logging

from sqlmodel import Session, col, select

from ...context import current, get_engine
from ...errors import CodedHTTPException
from ...models import ChannelFollow, KbChannel
from .. import app_settings
from . import channels
from . import search as kb_search

logger = logging.getLogger(__name__)

SETTING = "ask_subscriptions_indexed"


def _shape(url: str) -> str:
    """Whether a channel URL names the channel by handle or by id."""
    path = url.split("/", 3)[-1]
    if path.startswith("@"):
        return "handle"
    return "id" if path.startswith("channel/") else "other"


def _same_channel(
    url: str, name: str | None, known: list[tuple[str, str | None]]
) -> bool:
    """A subscription and an Ask channel are one channel when their addresses
    match, or their names do and one address is the handle, the other the id."""
    key = (name or "").strip().casefold()
    shape = _shape(url)
    for other_url, other_name in known:
        if other_url == url:
            return True
        if (
            key
            and key == (other_name or "").strip().casefold()
            and {shape, _shape(other_url)} == {"handle", "id"}
        ):
            return True
    return False


def add_subscribed(session: Session) -> int:
    """Queue every subscribed YouTube channel Ask does not have. Asks YouTube
    nothing: the worker's listing fills in the rest."""
    known = [
        (c.channel_url, c.channel_name) for c in session.exec(select(KbChannel)).all()
    ]
    follows = session.exec(
        select(ChannelFollow)
        .where(col(ChannelFollow.followed).is_(True))
        .order_by(col(ChannelFollow.created_at))
    ).all()
    added = 0
    for follow in follows:
        try:
            url = channels.parse_channel_input(follow.channel_url)
        except CodedHTTPException:
            continue  # not an address Ask can list (a playlist, another site)
        if _same_channel(url, follow.channel_name, known):
            continue
        session.add(
            KbChannel(
                channel_url=url,
                channel_name=follow.channel_name,
                added_by=follow.user_id,
            )
        )
        known.append((url, follow.channel_name))
        added += 1
    session.commit()
    return added


def add_subscribed_once() -> int:
    """Run ``add_subscribed`` if it never ran here. Waits (returns 0, and runs
    at the next start) while this SQLite cannot index for Ask at all."""
    if app_settings.load().get(SETTING):
        return 0
    with Session(get_engine()) as session:
        if not kb_search.fts_available(session):
            return 0
        added = add_subscribed(session)
    app_settings.save({SETTING: True})
    if added:
        logger.info("Ask: added %s subscribed channels", added)
        current().knowledge.wake.set()
    return added
