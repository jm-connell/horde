# 0043: A related list mixes in other interests by how crowded the topic is

Status: Accepted (supersedes [0041](0041-related-lists-keep-other-interests.md))

## Context

[0041](0041-related-lists-keep-other-interests.md) gave every fourth place in a related list to a pick from the viewer's Recommended feed about something else. That fixed the worst case (24 Counter-Strike videos under a Counter-Strike stream) but treated every list alike:

- A topic with a handful of videos runs out by itself and the list drifts to other things anyway; the inserts there only pushed out related videos. A topic with hundreds was still three quarters one topic.
- The rate was the same for everyone, although Recommended already knows how far each person wants to stray (their algorithm: Familiar, Explorer, their own shares).
- A pick was on the topic or off it. Something close to the video without being its topic (another shooter under Counter-Strike, another RP server) was treated like something unrelated, although it is often the best next thing.
- The picks came in feed order, so all of them could be one other interest.

## Decision

All in `services/discovery/other_interests.py`; the related endpoints only pass the share to `weave`.

- **The share follows how crowded the topic is.** `_scale` already measures the video against every vector Horde knows (library, channel video lists, found videos) to place the "about something else" cut; it also counts the known videos at or above it (the topic's depth). No share at 6 or fewer, the full share at 48 or more, in proportion between (`THIN_TOPIC`, `CROWDED_TOPIC`). Without a vector for the video (no embeddings, a video not embedded yet, or a stream opened by someone who may not use AI) there is no cut to measure: the list is then the channel's own videos, as one-topic as a list gets, and takes the full share, and any other channel's pick counts as another interest, as in 0041.
- **The viewer's algorithm sets the full share** (`Tuning.related_other_share`): the feed's share of new channels and throwbacks, the part of Recommended that leaves what the user watches now, mapped to 0.1..0.45. Balanced is about 0.29 (7 of 24 places on a crowded topic), Familiar 0.18 (4), Explorer 0.41 (9). No new setting: whatever moves those sliders moves this too.
- **More further down, never at the top.** The first three places are always on the topic (what autoplay plays next). After them the rate grows from 0.6 to 1.4 times the share over 16 places (`_rate`), with half a place owed up front so the first pick comes soon after the lead. Two picks are never next to each other, so where the rate passes one in two (Explorer, from about the 16th place) the rest of the list alternates. The places depend only on their position, so every page is a slice of one sequence, as before.
- **Nearby before unrelated, every interest a turn** (`_order`). A pick below the "something else" cut but in the upper half of the range below it (above `NEARBY_ABOVE`) is nearby. Picks are grouped by the feed's recent interest (`FeedItem.topic`; by channel when it has none) and taken in rounds: each round gives every interest one place, nearby picks first, then the feed's order.
- Unchanged from 0041: picks never come from the playing video's channel; a pick without a vector is left out when the video has one; a library video's list takes downloaded picks only; parental controls apply before the mixing, now to the on-topic videos too (a restricted member's endpoint drops other channels' videos; dropping them first keeps the lead on topic and the picks apart); the cached day's ranking is read, not ranked again; at most 48 picks per list.

## Consequences

- Under a thin topic a related list is as it was before 0041. Under a crowded one it leaves the topic more than 0041 did on Balanced (7 places rather than 6), and more again on Explorer. Those numbers can be tuned in one place (`related_other_share` and the constants in `other_interests.py`).
- The depth counts every vector known, so a video in the library and in a channel's video list counts twice, and a big indexed channel makes its topic crowded even if the viewer has little of it downloaded. Both push toward more variety, the direction this exists for.
- Changing the algorithm changes related lists on the next request: the feed is kept per tuning, so a list opened right after a change can pay for one feed ranking, as 0041 describes.
- Nearby is measured on the same scale as the cut, so it holds across embed models; with very few known vectors (a new install) the scale is rough and few picks count as nearby.
