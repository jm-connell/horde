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
5. Opening a category never waits on YouTube. Searching for a category
   happens in the background.

## Non-goals

- Changing "For you", its ranking or its buckets.
- Removing the site-wide AI categories. They stay for Settings -> AI and the
  tags on suggested channels; only the chips stop using them.
- User-editable categories (rename, pin, hide). Hand-added interests
  (`rec_topics`) already cover "I want more of X".

## Anti-goals

- A category that shows a loading state while YouTube is asked.
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
- Roughly one card in five is from a channel new to you; the rest are from
  the library, listed channels and channels you watch.
- No more than one card in four of any stretch is from the same channel.
- Opening a category tells the background worker you care about it; the next
  time it looks on YouTube that category's searches go first. When it has
  found more, the existing "Show new picks" pill appears. Next visit the
  category is richer.
- Refresh reshuffles a category as it does "For you".

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
- **Order**: close matches by fit plus the feed's small quality, freshness
  and shuffle terms; then the divider; then loose matches by fit.
- **Channel spread**: a greedy pass over that order allows a channel at most
  one card in any window of four; held-back cards rejoin as soon as they are
  allowed, so nothing is dropped, only spaced out.
- **Familiar and new**: candidates are split into familiar (library, catalog,
  or a channel the user has watched or follows) and new (the rest). The pass
  above draws four familiar for each new while both last.

The result is cached on the runtime beside the feed (same key plus the
category id, same lifetime), so paging uses offset cursors as today.

### Background searching

- `GET /api/discover/feed?category=<id>` on a first page stamps
  `rec_categories.wanted_at` and calls `gather.request_refresh` (which keeps
  its 20-minute minimum gap). It does not wait.
- `gather.plan_requests` puts the searches of categories wanted in the last
  day first, within the same `SEARCHES_PER_RUN`. Nothing else about the
  gatherer's budget changes.
- The page's existing status poll shows "Show new picks" when the run ends.

### API

- `DiscoverFeedRead.categories` becomes `[{id, name}]` (was a list of names).
- `category` on `GET /api/discover/feed` becomes the category id.
- A page in a category carries `loose_from`: the index of the first loose
  match on this page, or null, for the divider.
- `backend/openapi.json` and `frontend/src/api/schema.d.ts` regenerated.

### Frontend

- `CategoryChips` takes `{id, name}`; `DiscoverHome` keeps the open category
  by id and falls back to "For you" if it is gone after a refresh.
- The grid renders a full-width "Further afield" divider at `loose_from`.
- Infinite scroll is unchanged (it already pages a category).

### Docs

`docs/guides/library.md`, `docs/guides/ai-features.md`,
`docs/architecture/ai-pipeline.md`, `docs/architecture/data-model.md`,
`CHANGELOG.md`, and a new ADR (amending 0026) listed in `docs/adr/index.md`
and `mkdocs.yml`.

## My calls (not yet agreed)

- Watched videos stay out of a category, as in "For you": "known to the
  user" is read as known *sources*, not videos to rewatch.
- Four familiar to one new; one in four per channel; eight chips; twelve
  close matches to show a chip. Constants, easy to change.
- A category is "infinite" in the sense of everything Horde knows, loosest
  last, growing in the background, not an endless YouTube search.
- The site-wide AI categories and their refresh job stay as they are.

## Left to the builder

Exact floors and margins (tuned against the e2e seed and unit tests with
synthetic vectors), the cache key layout, and the divider's styling within
`DESIGN.md`.

## Verification

- Unit: stored categories keep id and name across a re-cluster; fit rule
  sends a video to its nearest category only; channel spread and the 4:1 mix;
  wanted categories' searches planned first.
- `TestClient`: the feed lists personal categories; a category pages past
  the old feed's members; opening one never calls YouTube.
- Playwright: chips show the seeded user's interests; a category scrolls
  through more than one page and shows the divider.
- Migration test (`tests/test_database_migrate.py`) and the full
  `scripts/check.sh --e2e`.
