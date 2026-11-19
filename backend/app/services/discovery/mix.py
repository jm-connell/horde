"""Mixing the buckets into one feed: each kind of pick gets its share (smooth
weighted round robin), a channel's picks are spread out and capped, and a
smaller interest is pulled forward when it has had less than its share."""

from __future__ import annotations

import math
from collections import Counter, defaultdict

from .picks import FeedItem, MixStat, name_key
from .tuning import DEFAULTS, Tuning

#: A channel appears at most this often in the whole feed in these buckets (the
#: channel suggestions show more of a new channel; ``new`` is the user's own
#: setting, and how far apart a channel's picks are is ``Tuning.channel_gap``).
CHANNEL_CAPS = {
    "new": DEFAULTS.new_channel_cap,
    "throwback": 3,
    "rewatch": 2,
    "interest": 3,
}
#: While other buckets have picks left, none takes more than this times its share.
OVERFILL = 1.3
#: How far past their asked-for share new channels, throwbacks and rewatches
#: may grow when another bucket is empty (the rest goes to the familiar ones).
SHARE_CAP_RATIO = {"new": 1.4, "throwback": 1.3, "rewatch": 1.5, "interest": 1.3}
#: See ``mix``: how strongly an under-served interest is pulled forward, and the
#: least share any recent interest is owed.
TOPIC_BONUS = 0.06
MIN_TOPIC_SHARE = 0.08
FEED_MAX = 800
#: How many of the top picks the target-vs-actual mix is measured over.
MIX_STATS_TOP = 60
#: The top of the feed is for what the user watches now: no throwback is
#: placed in its first ``THROWBACK_HOLD`` slots (while anything else can be).
THROWBACK_HOLD = 12


def mix_stats(placed: list[FeedItem], shares: dict[str, float]) -> list[MixStat]:
    """What the user asked each bucket to get, and what the top of the feed got."""
    top = placed[:MIX_STATS_TOP]
    counts = Counter(item.bucket for item in top)
    return [
        MixStat(bucket, target, counts[bucket] / len(top) if top else 0.0)
        for bucket, target in shares.items()
        if target > 0
    ]


def effective_shares(
    present: set[str], tuning: Tuning = DEFAULTS, interest_share: float = 0.0
) -> dict[str, float]:
    """The user's shares over the buckets that still have picks, summing to 1.

    The share of an empty bucket goes to the others in proportion, except that
    new channels, throwbacks and rewatches stay near what was asked for
    (``SHARE_CAP_RATIO``): what they cannot take goes to the familiar buckets.
    """
    asked = {k: v * (1 - interest_share) for k, v in tuning.shares.normalized().items()}
    asked["interest"] = interest_share
    total = sum(asked[n] for n in present)
    if total <= 0:
        return {n: 1.0 / len(present) for n in present}
    out = {n: asked[n] / total for n in present}
    familiar = [n for n in ("subscriptions", "similar") if out.get(n, 0.0) > 0]
    if not familiar:
        return out
    spare = 0.0
    for name, ratio in SHARE_CAP_RATIO.items():
        cap = asked[name] * ratio
        if name in out and out[name] > cap:
            spare += out[name] - cap
            out[name] = cap
    if spare:
        base = sum(out[n] for n in familiar)
        for n in familiar:
            out[n] += spare * out[n] / base
    return out


def mix(
    buckets: dict[str, list[FeedItem]],
    topic_shares: dict[int, float] | None = None,
    tuning: Tuning = DEFAULTS,
    interest_share: float = 0.0,
    limit: int = FEED_MAX,
) -> list[FeedItem]:
    """Interleave the buckets by the user's shares (smooth weighted round robin),
    stopping after ``limit`` picks: the feed keeps no more.

    A pick must keep its channel ``channel_gap`` slots from its last showing and
    its bucket within ``OVERFILL`` times its share; when no bucket can pick that
    way, the spacing and share give way, but the per-channel caps never do:
    picks past a cap wait at the end, best first.

    Within a bucket, a pick from an interest that has had less than its share
    of the history (``topic_shares``, at least ``MIN_TOPIC_SHARE``) gets
    ``TOPIC_BONUS`` per missing slot, so a smaller interest still shows up
    between the big ones.

    Throwbacks sit out the first ``THROWBACK_HOLD`` slots and earn no credit
    meanwhile, so they do not bunch up right after.
    """
    gap = tuning.channel_gap
    caps = {**CHANNEL_CAPS, "new": tuning.new_channel_cap}
    shares = {t: max(v, MIN_TOPIC_SHARE) for t, v in (topic_shares or {}).items()}
    topic_picks: Counter[int] = Counter()
    #: Picks past their channel's cap: they go after everything else.
    overflow: list[FeedItem] = []
    queues = {name: list(items) for name, items in buckets.items() if items}
    credit = dict.fromkeys(queues, 0.0)
    picks: defaultdict[str, float] = defaultdict(float)
    shown: dict[str, Counter[str]] = defaultdict(Counter)
    out: list[FeedItem] = []
    last_channels: list[str] = []

    def capped(item: FeedItem) -> bool:
        cap = caps.get(item.bucket)
        name = name_key(item.candidate.channel)
        return cap is not None and bool(name) and shown[item.bucket][name] >= cap

    def spaced(item: FeedItem) -> bool:
        name = name_key(item.candidate.channel)
        return gap <= 1 or not name or name not in last_channels[-(gap - 1) :]

    def within_share(bucket: str) -> bool:
        if len(queues) == 1:
            return True
        limit = max(1, math.floor(share[bucket] * OVERFILL * (len(out) + 1)))
        return picks[bucket] < limit

    def cost(item: FeedItem) -> float:
        """What a pick takes of its bucket's share: less for a downloaded one
        when the user prefers those, so they can fill more of the feed."""
        return tuning.library_pick_cost if item.candidate.pool == "library" else 1.0

    def priority(item: FeedItem) -> float:
        if item.topic is None or item.topic not in shares:
            return item.score
        owed = shares[item.topic] * (len(out) + 1) - topic_picks[item.topic]
        return item.score + TOPIC_BONUS * max(0.0, owed)

    def choose(order: list[str], strict: bool) -> tuple[str, int] | None:
        for name in order:
            if strict and not within_share(name):
                continue
            usable = [
                (priority(item), -j, j)
                for j, item in enumerate(queues[name][:12])
                if not capped(item) and (not strict or spaced(item))
            ]
            if usable:
                return name, max(usable)[2]
        return None

    share: dict[str, float] = {}
    while queues and len(out) < limit:
        active = set(queues)
        if len(out) < THROWBACK_HOLD and len(active) > 1:
            active.discard("throwback")
        share = effective_shares(active, tuning, interest_share)
        for name in active:
            credit[name] += share[name]
        order = sorted(active, key=lambda n: -credit[n])
        picked = choose(order, strict=True) or choose(order, strict=False)
        if picked is None:
            # Only capped picks at the heads: set every capped pick aside, go again.
            for name in list(queues):
                overflow.extend(it for it in queues[name] if capped(it))
                kept = [it for it in queues[name] if not capped(it)]
                if kept:
                    queues[name] = kept
                else:
                    del queues[name]
                    credit.pop(name, None)
            continue
        name, j = picked
        item = queues[name].pop(j)
        credit[name] -= cost(item)
        picks[name] += cost(item)
        out.append(item)
        channel = name_key(item.candidate.channel)
        last_channels.append(channel)
        shown[item.bucket][channel] += 1
        if item.topic is not None:
            topic_picks[item.topic] += 1
        if not queues[name]:
            del queues[name]
            credit.pop(name, None)
    overflow.sort(key=lambda it: -it.score)
    return (out + overflow)[:limit]
