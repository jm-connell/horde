# 0026. One Recommended tab: the Recommended+ feed

Status: Accepted (amends [0019](0019-recommended-plus.md))

## Context

The home page had three tabs: Library, Recommended ("For you" from the library and indexed channels, ranked by `services/ai/recommend.py`, plus AI category shelves) and Recommended+ (the mixed, tunable feed of [0019](0019-recommended-plus.md) and [0024](0024-tunable-recommended-plus.md)). Recommended+ already read the library and every indexed channel, gained the same AI categories, and ran from those sources alone when looking on YouTube was off. Two rankers did nearly the same job, users had to pick between them, and fixes landed in one but not the other.

## Decision

- **One tab.** The home page has Library and Recommended. Recommended is the Recommended+ feed (`GET /api/discover/feed`, `services/discovery/`). It is always offered: with looking on YouTube off it simply has no found videos.
- **The old ranker goes.** `GET /api/ai/recommendations` and the "For you" ranking in `services/ai/recommend.py` are removed. That module keeps the AI category rule, which `GET /api/ai/categories`, Settings -> AI and the feed's category chips (`discovery/categories.py`) use.
- **What the old tab offered maps onto the feed.** Its **Include not downloaded** chip is the algorithm's **Indexed channels** source; its category shelves are the feed's category chips; its admin **Refresh** is **Settings -> AI -> Jobs**.
- **The tab choice is remembered per browser** (`horde.home.tab` in local storage). A saved `discover` (Recommended+) opens Recommended. A search shows library results without changing the saved choice.
- Internal names stay: the API, tables and code still say `discover` / `discovery`; only what users read changed.

## Consequences

- One ranking to tune and fix. Without AI it ranks from the watch history (channel and tag taste), as the old tab did.
- Throwbacks are the feed's throwback share rather than the old "one in twenty" slot, and live broadcasts lead the first page as before.
- Clients of `GET /api/ai/recommendations` (none outside the app) must move to `GET /api/discover/feed`.
