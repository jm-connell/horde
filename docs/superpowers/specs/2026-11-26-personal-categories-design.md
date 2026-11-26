# Personal categories on Recommended

Status: proposed, awaiting approval

## Intent

Someone who picks a category on Recommended is browsing for something new on
a subject they care about. Today that does not work well:

- The chips are the site-wide AI categories, invented from a sample of the
  library. They are the same for every account and know nothing about what a
  person streams or how their algorithm sees them.
- A category is a filter over the person's ranked "For you" feed (at most 800
  picks). A listed channel contributes its whole upload list to that feed
  while YouTube contributes a few searches, so a category fills with whatever
  uploads of a listed channel sit nearest to it ("Programming and software"
  is mostly Linus Tech Tips).
- The list ends when the feed's members in the category run out.

## Goals

1. The chips are the person's own interests: what they downloaded and watched
   lately, grouped the way their algorithm already groups it.
2. A category shows the videos that are really about it, mostly from sources
   the person knows (the library, listed channels, channels they have watched
   or follow), with a sprinkle of channels new to them.
3. No channel dominates a category.
4. A category goes deep: it keeps scrolling well past today's end.
5. Opening a category never waits on YouTube. Categories are prepared in the
   background, and so is searching YouTube for them. Only at the very end of
   a category may the page show a loading state while more is fetched.
6. Old videos do not crowd a category where age matters (a 2022 tablet review
   under tech), unless the person has been watching exactly that lately.
7. A category suggests channels, as "For you" does.
8. Algorithm and Refresh sit at the right end of the chip row.

## Non-goals

- Changing "For you", its ranking or its buckets.
- Removing the site-wide AI categories. They stay for Settings -> AI and the
  tags on suggested channels; only the chips stop using them.
- User-editable categories (rename, pin, hide). Hand-added interests
  (`rec_topics`) already cover "I want more of X".

## Anti-goals

- A category that shows a loading state when it is opened, or anywhere
  before the end of what Horde already knows.
- A fixed ratio of familiar to new videos that ignores the person's algorithm
  and how much there is to show.
- Asking YouTube more often than the gatherer's budget allows
  (`discovery/gather.py`: hourly cap, pauses, backoff).
- Chips that rename or reorder themselves between two visits on the same day.

## How it should feel

- The chip row reads "For you" and then up to eight of your interests, the
  ones you are most into first, with short names ("Home servers", "Rust",
  "Woodworking"). Older interests you have drifted from sit at the end.
- Tapping one shows a full grid at once, from what Horde already knows.
- The first screens are the closest matches. Scrolling on, the matches get
  gradually looser instead of the list ending; a quiet "Further afield"
  divider marks where the close matches stop.
- The top of a category is familiar: the library, listed channels, channels
  you watch or follow. Channels new to you appear after the first row and
  more often the further you scroll, where someone who has seen the familiar
  ones is looking. How many depends on your algorithm (Explorer sees more
  than Familiar) and on how much familiar material the category has.
- No more than one card in four of any stretch is from the same channel.
- In a category where you watch recent uploads, old videos sink to "Further
  afield". In one where you watch old videos, they do not.
- After the first full rows, a "Channels you might like" row for this
  category, like the one in "For you".
- Opening a category tells the background worker you care about it; the next
  time it looks on YouTube that category's searches go first. Next visit the
  category is richer.
- Getting near the end starts a search for more in the background, so it is
  usually there by the time you arrive. If you outrun it, a loading mark at
  the end, then more cards. When YouTube has nothing more for now: "That's
  everything for now".
- Algorithm and Refresh are at the right end of the chip row, after a thin
  vertical rule; the chips scroll under their own arrows to the left of it.
  Refresh reshuffles a category as it does "For you".

## Approaches considered

1. **Filter the ranked feed harder** (keep today's design, add a per-channel
   cap). Small, but still capped at the feed's 800 picks, still made of what
   "For you" happened to pick, and still site-wide chips. Fails goals 1 and 4.
2. **Search YouTube when a category is opened.** Fresh and endless, but the
   person stares at a spinner, results are mostly strangers, and it spends
   the YouTube budget in the foreground. Fails goals 2 and 5.
3. **Rank the whole candidate pool against the category, search in the
   background (chosen).** Every video Horde knows (library, listed channels'
   uploads, videos found on YouTube) is scored against the category's centre.
   Instant, deep (thousands of candidates on an install with listed channels),
   mostly familiar sources, and the gatherer already searches YouTube per
   interest group, so new videos arrive without a new mechanism.

## Design

### Categories are stored interests

A new table `rec_categories`, one row per (user, interest): `id`, `user_id`,
`name`, `era` (`recent` | `throwback`), `centroid` (packed vector), `dim`,
`weight`, `queries_json`, `wanted_at`, `updated_at`.

`discovery/interests.py` already groups a person's recent watches (library and
streamed) into at most six recent and three dormant interests by k-means over
their embeddings, and writes YouTube searches for each. A refresh step
(`discovery/category_store.py`, new):

1. computes the current groups for the user;
2. matches each to a stored row by centre similarity (>= 0.8, the existing
   `DORMANT_SIMILARITY`): a match keeps its id and name and takes the new
   centre, weight and era, so a chip does not rename as the history shifts;
3. names the unmatched groups: with a chat model, one call returns a name of
   one to three words per group (the gatherer's existing query prompt gains a
   `name` field, so a gather run costs no extra call); without one, the
   group's two most distinctive title words or its top tag, title-cased;
4. deletes rows no group matched for 14 days.

It runs after each gatherer run and, so categories work with looking on
YouTube off, from the warm worker at most every six hours per active user
(with keyword names when it may not use the chat model). Without embeddings
there are no groups worth naming (a group is a channel then), so there are no
chips, as today without AI.

Shown: up to eight, recent before throwback, heaviest first, and only those
with at least `MIN_CATEGORY_PICKS` (12) close matches, so no chip opens onto
a near-empty page.

### What a category shows

`discovery/categories.py` is rewritten around one function,
`category_feed(session, runtime, user_id, category, seed) -> list[FeedItem]`:

- **Pool**: the same candidates as the feed (library, catalog, discovered),
  after the same exclusions (watched, "not interested", blocked channels and
  topics, parental controls, the algorithm's source switches). Not the 800
  ranked picks.
- **Fit**: cosine to the category's centre. A candidate is a *close match*
  when it clears a floor relative to the category's best matches (the idea of
  `recommend.category_members`: within a margin of the top hits, so it works
  across embedding models) **and** this category is its best or near-best
  among the user's categories. A hardware video is nearer to "PC hardware"
  than to "Programming", so it leaves the latter. Everything else above a
  low absolute floor is a *loose match*.
- **Age**: each category has a half-life learned from the person, not a
  label. For the category's own watches, take how old each video was when it
  was watched; the half-life is twice the 75th percentile of those ages,
  never under 90 days, and none at all (age ignored) when it comes to more
  than five years or fewer than five of the watches have an upload date. Fit
  is multiplied by `0.5 ** (age / half_life)`, floored at 0.25 so age alone
  never removes a video; a close match whose aged fit drops below the close
  floor becomes a loose one. Someone who watches this month's reviews gets a
  short half-life and 2022 reviews sink; someone who has been watching 2022
  reviews has old ages in the category, a long half-life, and keeps them.
  `rec_categories.half_life_days` stores it (null: age ignored).
- **Order**: close matches by aged fit plus the feed's small quality and
  shuffle terms; then the divider; then loose matches the same way.
- **Channel spread**: a greedy pass over that order allows a channel at most
  one card in any window of four; held-back cards rejoin as soon as they are
  allowed, so nothing is dropped, only spaced out.
- **Familiar and new**, borrowing ADR 0043's rules for related lists (open
  PR 206) instead of a fixed ratio. Familiar: the library, a listed channel,
  or a channel the user has watched or follows. New: the rest.
  - *The algorithm sets the share*: the feed's share of new channels
    (`Tuning.shares`), mapped to 0.1..0.45 as `related_other_share` maps it.
  - *Supply scales it*: with 48 or more familiar close matches the share is
    as above; with fewer it rises in proportion, to 1 at six or fewer
    (the mirror of 0043's crowding: there a thin topic needs no inserts,
    here a thin familiar supply needs more new).
  - *More further down*: the first row is familiar; after it the rate grows
    from 0.6 to 1.4 times the share over the next 16 places, two new cards
    are never adjacent, and new cards take turns by channel.
  The placement depends only on position, so every page is a slice of one
  sequence. The rate function is shared with `other_interests.weave` once
  PR 206 is merged (see Dependencies).

The result is kept on the runtime beside the feed (same key plus the
category id, same lifetime) and is append-only during a visit, so offset
cursors stay valid when more is added at the end. The warm worker ranks the
categories of today's feed in the background along with the feed, so opening
one only reads.

### Channels in a category

`GET /api/discover/channels` takes `category`. The suggestions are built as
for the feed (`suggest.suggestions`) from the category's new-channel close
matches: channels with the most and closest matches first, each with its
videos from this category. The frontend shows the row in a category as it
does in "For you".

### Background searching

- `GET /api/discover/feed?category=<id>` on a first page stamps
  `rec_categories.wanted_at`. It asks for no run (review finding: a run
  re-ranks the feed and would rebuild the list under the visit).
- `gather.plan_requests` puts one search of the categories wanted in the last
  day first, within the same `SEARCHES_PER_RUN`. Nothing else about the
  gatherer's budget changes.
- The page's existing status poll shows "Show new picks" when the run ends.

### The end of a category

- A page request that comes within two pages of the end of the kept list
  queues a *top-up* for that category: the gatherer wakes at once and runs up
  to two of the category's searches it has not run lately (further queries
  are written by the chat model, or from keywords, when the stored ones are
  used up), embeds what it found and appends the matches to the kept list.
  A top-up skips the 20-minute gap between refreshes but not the hourly cap,
  the pause between calls or a backoff.
- The feed response carries `more`: `none` (the list simply continues or has
  ended), `loading` (a top-up is queued or running) or `exhausted` (nothing
  further for now: budget, backoff, looking on YouTube off, or no new
  results). With `loading` and no `next_cursor` the client shows the loading
  mark at the end and asks again every few seconds with the same cursor;
  with `exhausted` it shows "That's everything for now".
- Lazy loading: because the top-up starts two pages early, a person scrolling
  at reading speed usually never sees the loading mark.

### API

- `DiscoverFeedRead.categories` becomes `[{id, name}]` (was a list of names).
- `category` on `GET /api/discover/feed` becomes the category id.
- A page in a category carries `loose_from`: the index of the first loose
  match on this page, or null, for the divider; and `more` (above).
- `GET /api/discover/channels` takes `category`.
- `backend/openapi.json` and `frontend/src/api/schema.d.ts` regenerated.

### Frontend

- `CategoryChips` takes `{id, name}`; `DiscoverHome` keeps the open category
  by id and falls back to "For you" if it is gone after a refresh.
- The grid renders a full-width "Further afield" divider at `loose_from`.
- Infinite scroll pages as today; at the end it follows `more`.
- Algorithm and Refresh move out of the page header's slot into the chip
  row: chips (with their scroll arrows) take the room on the left, then a
  1px vertical rule, then the two buttons (icons on phones, as now). The row
  shows even when there are no categories, with "For you" alone. The header
  slot (`actionsSlot`, `Library.tsx`) goes if nothing else uses it.
- The channel row shows in a category.

### Side quest: thumbnails missing on cards that are not downloaded

Reported: about one card in every five or six rows of Recommended shows no
thumbnail. Not yet diagnosed. Suspects, to be confirmed against a real
instance before any fix: a stored `thumbnail_url` that is the largest size
yt-dlp listed (`_best_thumbnail_url`) and does not exist for that video
(`maxresdefault` returns 404), a stored URL that has gone stale, and the
card having no fallback when the image fails. Fixed separately from the
categories work, in its own commit with a regression test, following the
debugging workflow (reproduce first).

### Docs

`docs/guides/library.md`, `docs/guides/ai-features.md`,
`docs/architecture/ai-pipeline.md`, `docs/architecture/data-model.md`,
`CHANGELOG.md`, and a new ADR (amending 0026) listed in `docs/adr/index.md`
and `mkdocs.yml`.

## My calls (not yet agreed)

- Watched videos stay out of a category, as in "For you": "known to the
  user" is read as known *sources*, not videos to rewatch.
- One in four per channel; eight chips; twelve close matches to show a chip.
  Constants, easy to change.
- Age sensitivity is learned from what the person watches in the category,
  not asked of the chat model: it needs no AI call and it is what makes the
  "2022 iPads lately" exception fall out by itself.
- A top-up is at most two searches, and a category ends with "That's
  everything for now" when the YouTube budget says so. Endless is not
  possible without ignoring that budget.
- The site-wide AI categories and their refresh job stay as they are.

## Dependencies

PR 206 (related lists adapt to the topic, ADR 0043) is open. This work
borrows its share-from-the-algorithm, supply scaling and growing rate. If it
merges first, the rate and share helpers are shared from
`other_interests.py` / `tuning.py`; if not, this branch carries its own
copy of the small rate function and the two are merged afterwards.

## Left to the builder

Exact floors and margins (tuned against the e2e seed and unit tests with
synthetic vectors), the cache key layout, and the divider's styling within
`DESIGN.md`.

## Verification

- Unit: stored categories keep id and name across a re-cluster; fit rule
  sends a video to its nearest category only; the half-life from watch ages
  (recent watchers sink old videos, old-video watchers keep them); channel
  spread; the new share by algorithm, supply and depth; wanted categories'
  searches planned first; a top-up appends without moving earlier offsets.
- `TestClient`: the feed lists personal categories; a category pages past
  the old feed's members; opening one never calls YouTube; nearing the end
  queues a top-up and reports `loading`, then `exhausted`; channels by
  category.
- Playwright: chips show the seeded user's interests; a category scrolls
  through more than one page and shows the divider; Algorithm and Refresh
  are in the chip row; the channel row shows in a category.
- Migration test (`tests/test_database_migrate.py`) and the full
  `scripts/check.sh --e2e`.
