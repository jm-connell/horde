"""One list of the channels someone keeps up with: followed, auto-downloaded or
cleaned up by a rule, with what each of those is set to."""

from __future__ import annotations

from sqlmodel import Session, select

from ..models import ChannelAutodownload, ChannelCatalog, ChannelRetention
from ..schemas import ChannelRetentionSummary, SubscriptionRead
from . import follows, library


def list_for(session: Session, user_id: int) -> list[SubscriptionRead]:
    """The user's followed channels plus every channel with automatic downloads or
    a cleanup rule (those are server-wide), sorted by name."""
    rows: dict[str, SubscriptionRead] = {}

    def row(url: str, name: str | None) -> SubscriptionRead:
        key = follows.normalize_channel_url(url)
        found = rows.get(key)
        if found is None:
            found = rows[key] = SubscriptionRead(channel_url=key, channel_name=name)
        elif name and not found.channel_name:
            found.channel_name = name
        return found

    for item in follows.list_follows(session, user_id):
        row(item.channel_url, item.channel_name).following = True

    for policy in session.exec(
        select(ChannelAutodownload).where(ChannelAutodownload.enabled == True)  # noqa: E712 - SQL column comparison, not a Python truth test
    ).all():
        sub = row(policy.channel_url, policy.channel_name)
        sub.autodownload = True
        sub.quality_preset = policy.quality_preset

    stats = library.channel_stats(session)
    count_by_name = {s.channel: s.count for s in stats}
    subs_by_name = {s.channel: s.subscriber_count for s in stats}
    url_by_name = {s.channel: s.channel_url for s in stats if s.channel_url}

    for rule in session.exec(
        select(ChannelRetention).where(ChannelRetention.enabled == True)  # noqa: E712 - SQL column comparison, not a Python truth test
    ).all():
        url = url_by_name.get(rule.channel)
        if not url:
            continue  # a rule for a channel without a YouTube link; listed on its page
        row(url, rule.channel).retention = ChannelRetentionSummary(
            keep_latest=rule.keep_latest,
            max_age_days=rule.max_age_days,
            remove_watched_after_days=rule.remove_watched_after_days,
        )

    for catalog in session.exec(select(ChannelCatalog)).all():
        listed = rows.get(follows.normalize_channel_url(catalog.channel_url))
        if listed is None:
            continue
        listed.checked_at = catalog.finished_at
        if not listed.channel_name:
            listed.channel_name = catalog.channel_name

    names_by_url = {
        follows.normalize_channel_url(url): name for name, url in url_by_name.items()
    }
    for sub in rows.values():
        # The library's name for the channel wins: it is what the sidebar shows.
        sub.channel_name = names_by_url.get(sub.channel_url) or sub.channel_name
        sub.video_count = count_by_name.get(sub.channel_name or "", 0)
        sub.subscriber_count = subs_by_name.get(sub.channel_name or "")
    return sorted(
        rows.values(), key=lambda s: (s.channel_name or s.channel_url).casefold()
    )
