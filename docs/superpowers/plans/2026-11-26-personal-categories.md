# Personal categories on Recommended: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Category chips on Recommended are the person's own interests, and a category is a deep, familiar-first list built from every video Horde knows, topped up from YouTube in the background.

**Architecture:** A per-user `rec_categories` table stores the interest groups `discovery/interests.py` already computes (name, centre, searches, seeds, age half-life). The ranked feed keeps its filtered candidate pool; `discovery/category_feed.py` scores that pool against the categories once per feed and builds each category's list (fit, age, channel spread, familiar/new woven with `other_interests.weave`). The gatherer gains a per-category top-up that appends to a kept list.

**Tech Stack:** FastAPI, SQLModel, Alembic, numpy; React, TypeScript, Tailwind; pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-26-personal-categories-design.md`

## Global Constraints

- Opening a category never calls YouTube in the request.
- The gatherer's hourly cap, pause between calls and backoff apply to top-ups; only the 20-minute refresh gap is skipped.
- A kept category list is append-only (offset cursors stay valid).
- Interface wording: "listed channels", "embeddings"; no "indexed" for either.
- Errors use `CodedHTTPException`; new response fields are declared in `response_schemas.py`; `openapi.json` and `schema.d.ts` are regenerated.
- No new module-level mutable state: state lives on `DiscoveryRuntime` or the `Feed`.

## Review Focus

1. A category deleted or re-clustered between two pages: the next page returns an empty page with `more: "none"`, not a 500, and the client falls back to "For you".
2. No embeddings at all: no categories listed, the chip row still shows "For you" and the buttons.
3. A member under parental controls: category lists and category channel suggestions respect the allow list (no channels suggested).
4. Looking on YouTube off, or the user's algorithm has YouTube off: the end of a category reports `exhausted` at once, never `loading`.
5. Vectors of two sizes after an embed model change: categories of the old size are ignored and replaced, not compared.

Each is pinned by a test in the task that owns the code (tasks 3, 4, 5).

## File structure

| File | Responsibility |
|------|----------------|
| `backend/app/models.py` | `RecCategory` |
| `backend/app/migrations/versions/0037_rec_categories.py` | the table |
| `backend/app/services/discovery/interests.py` | `Interest.name`; names from the chat model or keywords |
| `backend/app/services/discovery/category_store.py` (new) | sync groups to rows, half-life, `ensure`, `listed` |
| `backend/app/services/discovery/category_feed.py` (new) | fit, age, lists, channel stats, append |
| `backend/app/services/discovery/categories.py` | keeps `feed_categories` (AI category tags for suggestions); `in_category` goes |
| `backend/app/services/discovery/picks.py` | `Feed.pool`, `Feed.familiar`, `Feed.browse`; `FeedItem.loose` |
| `backend/app/services/discovery/topup.py` (new) | top-up requests, state, the run |
| `backend/app/services/discovery/gather.py` | sync after a run; wanted categories first; top-ups before due users |
| `backend/app/services/discovery/warm.py` | prepare categories with the feed |
| `backend/app/api/discover.py` | `category` id, `loose_from`, `more`, channels by category |
| `frontend/src/components/CategoryChips.tsx`, `DiscoverHome.tsx`, `pages/Library.tsx` | chips by id, buttons in the row, divider, end states, channel row |

---

### Task 1: `rec_categories` and stored interests

**Files:** `models.py`, migration `0037_rec_categories`, `interests.py`, `category_store.py`, `tests/test_discovery_categories.py` (new).

**Produces:**
- `RecCategory(id, user_id, name, named_by: "llm"|"keywords", era, centroid: bytes, dim, weight, half_life_days: float | None, queries_json, seeds_json, wanted_at, seen_at, updated_at)`; index on `user_id`.
- `Interest.name: str | None`; `llm_queries` asks for `"name"` (1 to 3 words) beside the queries; `keyword_queries` sets a title-cased name from the two most distinctive title words (or the top tag) when none.
- `category_store.sync(session, user_id, groups: list[Interest], now) -> list[RecCategory]`: match by centre (>= `interests.DORMANT_SIMILARITY`) or equal name; a match keeps id and name (a `keywords` name is replaced by an `llm` one); unmatched groups with a name and a centre become rows; rows unseen for 14 days are deleted; rows of another vector size are deleted.
- `category_store.half_life(ages_days: list[float]) -> float | None`: fewer than 5 ages -> None; `2 * p75`, at least 90; above `5 * 365` -> None.
- `category_store.ensure(session, runtime, user_id, now) -> None`: when the user has no row updated in the last 6 hours, compute the groups (as `gather_for` does), name them with keywords only, and `sync`.
- `category_store.rows(session, user_id) -> list[RecCategory]`: recent before throwback, heaviest first.

- [ ] Tests: a re-cluster with a shifted centre keeps id and name; an llm name replaces a keyword name and not the reverse; unseen rows go after 14 days; `half_life([10]*8) == 90`, `half_life([400]*8) == 800`, `half_life([1200]*8) is None`, `half_life([10]*4) is None`; rows of another dim are dropped; migration test passes.
- [ ] Implement, run `pytest tests/test_discovery_categories.py tests/test_database_migrate.py`, commit.

### Task 2: Category lists

**Files:** `picks.py`, `feed.py`, `category_feed.py`, `tests/test_discovery_categories.py`.

**Consumes:** Task 1 rows; `other_interests.weave`, `_crowding`; `Tuning.related_other_share`.

**Produces:**
- `Feed.pool: list[Candidate]` (every candidate that passed the feed's filters, rewatch favourites excluded), `Feed.familiar: Callable[[Candidate], bool]` data (`known_channels: set[str]`, `followed_urls: set[str]`), `Feed.browse: Browse | None`.
- `FeedItem.loose: bool = False`.
- `category_feed.prepare(session, runtime, feed, user_id, seed, tuning, now) -> Browse`: one similarity matrix pool x categories, kept on the feed under the categories' version (ids and `updated_at`).
- `Browse.listed -> list[RecCategory]` (at least `MIN_CATEGORY_PICKS = 12` close matches, at most `MAX_CHIPS = 8`), `Browse.items(category_id) -> list[FeedItem] | None`, `Browse.channels(category_id) -> dict[str, ChannelStat]`, `Browse.append(category_id, candidates) -> int`.
- Rules, constants in `category_feed.py`: position `(sim - p10) / (mean(top 10) - p10)` per category; aged position `pos * max(0.25, 0.5 ** (age_days / half_life))`; close: aged >= `CLOSE = 0.55` and within `COMPETE = 0.1` of the candidate's best category; loose: aged >= `LOOSE = 0.3`; order by aged + `0.05 * quality` + `0.03 * jitter(seed)`; `spread(items, window=4)` holds a channel to one per window; new share `s = related_other_share`, `s + (1 - s) * (1 - _crowding(familiar_close))`, woven with `weave`, leftovers appended; close tier then loose tier (`loose=True`).

- [ ] Tests (synthetic vectors, three categories): a video goes to its nearest category only; with a 90-day half-life a 4-year-old close match is loose, with none it is close; no channel twice in any 4 consecutive familiar places while others remain; first three places familiar and no two new adjacent; fewer familiar matches -> more new in the first 24; Explorer > Familiar; no vectors -> `listed == []`; `append` adds at the end and returns the count, ignoring keys already listed.
- [ ] Implement, run the file, commit.

### Task 3: The API

**Files:** `response_schemas.py`, `api/discover.py`, `warm.py`, `categories.py`, `suggest.py`, `openapi.json`, `tests/test_discovery.py`.

**Produces:**
- `DiscoverCategoryRead {id: int, name: str}`; `DiscoverFeedRead.categories: list[DiscoverCategoryRead]`, `loose_from: int | None`, `more: Literal["none", "loading", "exhausted"] = "none"`.
- `GET /api/discover/feed?category=<int>`; unknown id -> empty page.
- `GET /api/discover/channels?category=<int>` via `suggest.suggestions_from(stats, excluded, cold, categories)` (the existing body, taking the stats).
- First page calls `category_store.ensure`; the warm worker calls `ensure` and `prepare` after ranking.

- [ ] Tests (`TestClient`): replace `test_recommended_plus_can_be_browsed_by_category` with personal categories from seeded watches; a category pages past `FEED_MAX`-independent members with stable offsets; `loose_from` on the page where loose starts; unknown category -> `items == []`; a restricted member sees only allowed channels and no channel suggestions; no YouTube call when opening a category (the extract functions monkeypatched to fail).
- [ ] Regenerate `openapi.json`; commit.

### Task 4: Background searching and the end of a category

**Files:** `topup.py`, `gather.py`, `runtime.py`, `api/discover.py`, `tests/test_discovery_topup.py` (new).

**Produces:**
- `DiscoveryRuntime.topups: dict[tuple[int, int], TopUp]` (`state: "queued"|"running"|"done"`, `exhausted_until: float`).
- `topup.request(session, runtime, user_id, category_id) -> Literal["loading", "exhausted"]`: `exhausted` when looking on YouTube is off, the user's algorithm has YouTube off, backing off, or exhausted in the last 30 minutes; else queues and wakes the worker.
- `topup.run_pending(runtime, stopping, pause)`: for each queued top-up, at most `TOPUP_REQUESTS = 2` of: the category's searches (each with and without "this year") not asked within `ASK_COOLDOWN`, then up next lists of its seeds not asked within `SEED_COOLDOWN`; `store_results`, `embed_pending`, then `Browse.append` on every kept feed of the user; marks exhausted when nothing could be asked or nothing new fit. Uses `_take_budget`; does not call `forget_feeds`.
- `gather._loop` runs `run_pending` before `run_due`; `gather_for` calls `category_store.sync` and puts the searches of categories with `wanted_at` in the last day first.
- Feed endpoint in a category: first page stamps `wanted_at`; within two pages of the end calls `topup.request`; at the end returns `more` and, while `loading`, a `next_cursor` at the end offset.

- [ ] Tests: wanted searches planned first; a top-up appends without moving earlier offsets and the next page returns the new items; nothing to ask -> `exhausted`; YouTube off -> `exhausted` with no request made; the hourly cap halts a top-up; feeds are not forgotten by a top-up.
- [ ] Implement, run, regenerate `openapi.json` if changed, commit.

### Task 5: Frontend

**Files:** `api/schema.d.ts` (generated), `types.ts`, `api/discover.ts`, `queries/discover.ts`, `CategoryChips.tsx`, `DiscoverHome.tsx`, `pages/Library.tsx` and header, `e2e/recommended.spec.ts`, `DESIGN.md` if the row pattern is new.

- Chips take `{id, name}[]` and an `actions` node rendered after a 1px vertical rule at the right; the row renders with no categories.
- `DiscoverHome`: category by id (falls back to "For you" when the id is no longer listed); "Further afield" divider at `loose_from`; end states (`loading`: the loading mark and a retry of the same cursor every 3 s, at most 40 times; `exhausted`: "That's everything for now"); the channel row in a category (asks `getSuggestedChannels(seed, category)`).
- The header's `actionsSlot` is removed if nothing else uses it.

- [ ] Playwright (routes mocked as the existing category test does): chips by id; Algorithm and Refresh inside the chip row; divider shown; `loading` then more cards; `exhausted` message; channel row in a category.
- [ ] `npm run lint`, `typecheck`, the spec, commit.

### Task 6: Thumbnails on cards that are not downloaded

- [ ] Reproduce: find which stored `thumbnail_url` shapes fail (test `_best_thumbnail_url` against flat search and up next entries; check the card's image error handling).
- [ ] Regression test first, smallest fix, own commit. If it cannot be reproduced here, report what was checked and what to look at on the live instance instead of guessing.

### Task 7: Docs, review, gate

- [ ] `docs/guides/library.md`, `docs/guides/ai-features.md`, `docs/architecture/ai-pipeline.md`, `docs/architecture/data-model.md`, `CHANGELOG.md`, ADR `0044-personal-categories.md` (+ `docs/adr/index.md`, `mkdocs.yml`).
- [ ] One independent critical review of the branch; fix findings.
- [ ] `E2E_SHARDS=4 scripts/check.sh --e2e`; push.
