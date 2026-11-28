# 0044: Recommended's categories are each user's own interests

Status: Accepted (amends [0026](0026-one-recommended-tab.md))

## Context

[0026](0026-one-recommended-tab.md) kept the category chips above Recommended as the site-wide AI categories (`ai_categories`, invented from a sample of the library) applied to the feed. Three things were wrong with that for someone who picks a category to browse a subject:

- The chips were the same for every account and knew nothing of what a person streams or how their algorithm sees them.
- A category was a filter over the ranked feed (at most 800 picks). A listed channel puts its whole video list among the feed's candidates while YouTube contributes a few searches, so a category filled with whatever uploads of a listed channel sat nearest it: a hardware channel under "Programming and software".
- The list ended with the feed's members in the category.

## Decision

- **The chips are stored interests.** `discovery/interests.py` already groups a user's recent watches (library and streamed) by embedding and writes YouTube searches for each group. `category_store.sync` files those groups under rows of `rec_categories`: a group whose centre is within `DORMANT_SIMILARITY` of a row's (or that has its name) is that row, which keeps its id and name and takes the new centre, weight, searches and seed videos. A chat model's name replaces one made from title words, once. Rows no group matched for 14 days go. The gatherer syncs after each run; a first page and the warm worker call `ensure`, which brings them up to date without a chat model when they are more than six hours old, so they exist with looking on YouTube off.
- **A category's list is drawn from everything the feed considered** (`Feed.pool`: library, listed channels, found videos, after the feed's exclusions), not from the ranked picks (`category_feed.py`). Closeness to the category's centre is placed between what the embed model gives unrelated videos (the pool's bottom tenth) and the category's ten nearest, so the cuts hold across models. A *close* match clears 0.55 on that scale and is within 0.1 of its best category; anything else above 0.3 is *loose* and listed after the close ones under "Further afield".
- **Age is learned per category, not labelled.** `half_life_days` is twice the 75th percentile of how old the category's watched videos were when watched (at least 90 days; none below five dated watches or above five years). Fit is multiplied by `0.5 ** (age / half_life)`, never below a quarter. A user who watches this month's reviews gets old reviews moved to loose; one who has been watching 2022 reviews has old ages there and keeps them.
- **No channel more than one place in four** while another has something to show; held-back videos take the next place they may, none is dropped.
- **Familiar and new are woven as [0043](0043-related-lists-adapt-to-the-topic.md) weaves related lists** (`other_interests.weave`). Familiar: the library, a listed channel, or a channel the user has watched or follows. The share of new channels is the feed's share of new channels (`Tuning.category_new_share`, 0.1..0.45), raised toward all of it as the familiar close matches fall from 48 to 6, absent from the first three places and growing down the list.
- **YouTube is asked in the background only.** Opening a category stamps `wanted_at`; the gatherer's next run puts one of that category's searches first. No run is asked for on opening: a run ends by ranking the feed anew, which would change the list under the visit. A page within two pages of a list's end queues a *top-up* (`topup.py`): the worker makes at most two requests for the category (its searches at any age, then for this year, then its watches' up next lists, none within its cooldown), embeds the finds and appends those that fit, and that the feed's own filters let in (`Feed.admits`: not watched or blocked, within the algorithm's lengths, ages and sources), to the kept list. While nothing has arrived the page asks again every three seconds, for two minutes at most. The request answers `more: loading | exhausted` at once. A top-up skips the 20-minute gap between a user's refreshes and nothing else: the hourly cap, the pause between calls and a backoff apply.
- **API.** `GET /api/discover/feed`: `categories` is `[{id, name}]`, `category` is the id, and a category page carries `loose_from` and `more`; `GET /api/discover/channels` takes `category`.
- **The site-wide AI categories stay** for Settings -> AI and the tags on suggested channels (`discovery/categories.py`).

## Consequences

- A kept category list only grows at its end, so the offsets of a visit hold through a top-up. The lists made for a ranked feed stay for as long as it is kept, also when the categories' centres are brought up to date meanwhile; only a new category, a new name or a new half-life measures again. A gatherer run still ranks the feed anew, as it always did.
- A topic blocked by meaning (not by word) is not checked on a top-up's finds until the feed is next ranked.
- Without embeddings there are no categories (a group is then a channel, which is not a subject). Names come from the chat model only through the gatherer, so with looking on YouTube off they are title words and tags.
- A category cannot be endless: it ends when the YouTube budget, a backoff, or the searches' cooldowns say so, and says "That's everything for now".
- The close and loose cuts, the spread and the top-up size are constants in `category_feed.py` and `topup.py`.
- Clients of `GET /api/discover/feed` that read `categories` as names, or sent a name as `category`, must move to ids (none outside the app).
