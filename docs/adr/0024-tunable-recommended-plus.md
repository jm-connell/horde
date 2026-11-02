# 0024. Recommended+ is tuned per user, with every value on show

Status: Accepted

## Context

[ADR 0019](0019-recommended-plus.md) ranked everyone's Recommended+ feed with the same constants (bucket shares, relevance floors, freshness half-lives, jitter, channel spacing, impression wear), kept at the top of `discovery/feed.py`. People watch differently: one wants mostly new uploads from their channels, another wants channels they have never seen, a third wants no Shorts. A feed that cannot be steered, and does not say why it picked something, is one people stop trusting.

Two limits stay from 0019. Every YouTube request counts against the same bot checks as downloads, so a setting must never raise how often Horde asks YouTube. And recommendations must stay sensible on any embed model and without one.

## Decision

- **The constants become a per-user `Tuning`** (`services/discovery/tuning.py`): bucket shares, strictness per bucket, freshness, a popularity lean (hidden gems to popular), channel spacing and the cap per new channel, shuffle, when an unwatched video drops to the end, the recent-taste window and how far back throwbacks reach, a minimum watched share for a watch to count as taste, hard filters (Shorts, past live streams, length, upload age), sources (library, indexed channels, found on YouTube, the household lift) and a library preference. Each value maps onto something the ranking already did; the properties on `Tuning` are the one place a slider's meaning is defined. Nothing that would change how much Horde asks YouTube is tunable; turning "found on YouTube" off stops the gatherer for that person.
- **Presets plus own values.** Balanced is the old constants plus a small rewatch share; Catch up, Familiar, Explorer and Nostalgia are fixed alternatives. Moving anything makes the user's own "Custom" values, kept while a preset is picked. Stored in `user_settings.rec_tuning_json` (validated with limits on every value, outside the free-form `ui_json` so a UI save cannot overwrite it); unreadable values fall back to Balanced. Anyone signed in may tune their own feed; there is no permission or administrator lock.
- **A fifth bucket, rewatch:** videos finished (or watched again on YouTube) a while ago and not since, from the library, streams or the Takeout import. It is the one bucket that shows watched videos.
- **Transparent.** Every pick carries the parts its score adds up to and where it was found (`why` on each feed item), and the first page reports the asked-for and the actual share of each bucket (`mix`), so a bucket that ran dry is explained, not mistaken for a broken slider.
- **Instant.** The tuning is part of the ranked-feed cache key, so a change re-ranks the next request. The panel saves a short moment after the last move; the feed reloads in place.
- **Topics typed in by hand** (`rec_topics`, `services/discovery/topics.py`): an interest gets its own share of the feed by strength (at most 35% for all), and its text becomes a search the gatherer runs first (two a run, once a day, inside the existing budget). A block leaves videos out by its words (everywhere recommendations are made) or by meaning (Recommended+). Matching by meaning compares a candidate with the rest of the pool (how many standard deviations above the mean), because raw similarities differ between embed models, and also asks for a modest absolute similarity (`MIN_TOPIC_COSINE`), so a pool with nothing about the topic matches nothing; it stays a best guess, which is why words are the default. A topic's embedding is asked for at most three at a time per ranking, and a failure is not retried for ten minutes, so a slow provider cannot stall the feed. Topics expire (and stay listed, switched off) and belong to the user, not to a set of slider values.
- **One panel, two places.** The Algorithm button on the feed opens the settings in the side panel Ask about Horde uses; with both open they become tabs, not two panels. Account settings shows the same component, reading and saving the same values.

## Consequences

- Balanced ranks almost exactly as before; the 4% rewatch share is the only change for people who never touch it.
- A share of 0 removes that kind of pick entirely (not even at the end of the feed). New channels, throwbacks and rewatches may still grow past what was asked for when the familiar buckets run dry, but only to 1.3–1.5 times their share.
- Ranking constants that are not user-facing (calibration, topic balancing, the household threshold) stay module constants; changing them still changes every feed.
- `GET`/`PUT /api/discover/tuning` read and save the settings; the response schema marks every value present, so the generated `Tuning-Output` type has no optional fields.
