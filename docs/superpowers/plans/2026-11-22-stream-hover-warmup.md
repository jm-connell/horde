# Stream Hover Warm-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the mouse rests on a card for a video that isn't downloaded, load
its details and build its manifest so the click plays at once. Also fix the
manifest build race that this would otherwise trigger.

**Architecture:**
- **Backend:** at most one manifest build or refresh per URL at a time, reusing
  `stream_preview._preview_refresh_inflight`.
- **Frontend:** a `StreamWarmer` per `QueryClient`.
  - It prefetches `/api/preview/meta` into the query the watch page already
    reads, then GETs `/api/preview/manifest`.
  - It runs one warm-up at a time with a newest-wins pending slot.
  - A hook gives cards pointer and focus handlers.

  The watch page opens on warmed details without refetching them, and marks
  them stale when it's left.

**Tech Stack:** FastAPI + pytest (backend), React 18 + TanStack Query +
vitest (node env, no DOM) + Playwright (frontend).

**Spec:** `docs/superpowers/specs/2026-11-22-stream-hover-warmup-design.md`

## Global Constraints

- Dwell before a warm-up: `WARM_DWELL_MS = 120`.
- Skip a URL warmed in the last `WARM_REPEAT_MS = 180_000` (3 min). A failed
  warm-up may be retried at once.
- One warm-up in flight per tab, one pending slot, newest wins. A started
  warm-up is never aborted.
- **Triggers:**
  - mouse only (`pointerType === "mouse"`) for rest and button-down;
  - keyboard focus only (`:focus-visible`) for focus;
  - never touch.
- Fetch the manifest only when the details came back with `is_live` false and
  `library_video_id` null.
- Warm-ups don't use `utils/ytPreviewQueue`.
- No new endpoint, no new backend module-level state (reuse
  `_preview_refresh_inflight`). Frontend state lives per `QueryClient`, so
  tests never reset anything.
- Library cards and `/watch/<id>` links are never warmed.
- **Project gates (CLAUDE.md):**
  - `ruff check`, `ruff format --check`, `mypy` at zero errors;
  - `npm run lint` (eslint `--max-warnings 0`), `npm run format`,
    `npm run typecheck`, `npm test`.
- **Commits:** imperative subject under 72 characters, a body saying why, and
  these trailers:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VcfAGi49voSgGCV4KskrgB
  ```
- Never stage `frontend/package-lock.json`. Its working-tree change comes from
  the environment's setup, not from this work.

## Review Focus

1. **A warm-up fails** (502 from YouTube, 403 from parental controls). The
   click still loads normally and shows the real result. → Task 3,
   `a failed warm-up does not stop the click`.
2. **The warm-up's manifest build fails while the click's request waits on
   it.** The waiting request builds itself rather than erroring. → Task 1,
   `test_a_waiter_builds_when_the_first_build_failed`.
3. **A build never finishes.** A waiting request gives up with "try again"
   (503-style `retry_after=5`) instead of hanging. → Task 1,
   `test_waiting_for_a_stuck_build_gives_up`.
4. **Leaving a warmed video and opening it again.** The second visit fetches
   fresh details, so the resume point is current. → Task 3,
   `coming back to a warmed video asks again`.
5. **A click lands before the warm-up's details request has answered.** One
   shared request, not two. → Task 3,
   `a click right after mouse-down shares the request`.

---

### Task 1: One manifest build per video at a time

**Files:**
- Modify: `backend/app/services/stream_preview.py` (constants near line 67;
  `resolve_preview_manifest` near line 895; `media_refresh_in_flight`
  docstring near line 970)
- Test: `backend/tests/test_stream_preview.py`
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Fixed`; add the heading if it
  is missing)

**Interfaces:**
- Produces: `_PREVIEW_BUILD_FOLLOW_WAIT_SEC: float = 90.0`. The signature
  `resolve_preview_manifest(url: str, *, force: bool = False) -> dict[str, Any]`
  is unchanged.

- [ ] **Step 1: Write the failing tests** in `backend/tests/test_stream_preview.py`

Share a fixture that gives each test empty caches and a controllable build:

```python
import threading
import time

import pytest

URL = "https://youtu.be/build-once-test"


def _entry(token: str) -> dict:
    now = time.time()
    return {
        "token": token,
        "source_url": URL,
        "formats": {
            "299": {
                "direct_url": f"https://cdn.example/{token}.mp4",
                "http_headers": {},
                "content_type": "video/mp4",
            }
        },
        "extracted_at": now,
        "expires_at": now + 3600,
    }


@pytest.fixture
def builds(monkeypatch):
    """Empty manifest caches; `_build_manifest_entry` blocks until `release`."""
    for name in (
        "_preview_manifest_by_url",
        "_preview_manifest_by_token",
        "_preview_refresh_inflight",
    ):
        monkeypatch.setattr(stream_preview, name, {})
    monkeypatch.setattr(
        stream_preview, "_extract_preview_info", lambda url, *, force=False: {}
    )
    state = {"calls": 0, "release": threading.Event(), "fail_first": False}

    def build(url, info):
        state["calls"] += 1
        call = state["calls"]
        state["release"].wait(5)
        if state["fail_first"] and call == 1:
            raise RuntimeError("probe failed")
        return _entry(f"tok{call}")

    monkeypatch.setattr(stream_preview, "_build_manifest_entry", build)
    return state
```

Tests (start each in its own thread, wait until `builds["calls"] >= 1`, then
`time.sleep(0.2)` so the second request is under way, then `release.set()`,
then join every thread with `timeout=5`):

- `test_concurrent_resolves_build_once`:
  - two threads call `resolve_preview_manifest(URL)`;
  - `builds["calls"] == 1`;
  - both results have `token == "tok1"`;
  - `stream_preview.lookup_preview_media("tok1", "299")["direct_url"] ==
    "https://cdn.example/tok1.mp4"`.
- `test_a_waiter_builds_when_the_first_build_failed`:
  - `builds["fail_first"] = True`;
  - the first thread's call raises `RuntimeError`, captured in the thread;
  - the second returns `token == "tok2"`;
  - `builds["calls"] == 2`.
- `test_waiting_for_a_stuck_build_gives_up` (uses `builds` for the empty
  caches, no threads):
  - monkeypatch `_PREVIEW_BUILD_FOLLOW_WAIT_SEC` to `0.05`;
  - `monkeypatch.setitem(stream_preview._preview_refresh_inflight, URL,
    threading.Event())`;
  - `pytest.raises(stream_preview.PreviewRefreshError)` around
    `resolve_preview_manifest(URL)`;
  - `caught.value.retry_after == 5`.

- [ ] **Step 2: Run the tests to check they fail**

Run: `cd backend && pytest tests/test_stream_preview.py -q`
Expected:
- `test_concurrent_resolves_build_once` fails (`calls == 2`).
- `test_waiting_for_a_stuck_build_gives_up` fails after about 5 s: today's
  code ignores the in-flight event and builds.
- `test_a_waiter_builds_when_the_first_build_failed` may already pass, because
  today's code builds twice anyway. It pins the waiter's retry, which the fix
  must keep.

- [ ] **Step 3: Implement single-flight for non-forced resolves**

In `resolve_preview_manifest`, the `not force` branch does this:
1. Return a cached entry with more than 60 s left, as `_do_resolve_preview_manifest`
   does today.
2. Otherwise, under `_preview_stream_lock`, become the leader by registering a
   `threading.Event` in `_preview_refresh_inflight[url]`, or follow the one
   already there.
3. **A leader** runs `_do_resolve_preview_manifest(url, force=False)`. In a
   `finally`, it pops the event and sets it, the same way the force branch's
   `finally` does.
4. **A follower** waits up to `_PREVIEW_BUILD_FOLLOW_WAIT_SEC`. On timeout it
   raises `PreviewRefreshError("Preview manifest is still being built",
   retry_after=5)`. After the wait it returns the cached entry. If there is
   none because the leader failed, it goes round once more as a would-be leader
   (at most two rounds), so concurrent waiters still build once.

The force branch is unchanged. It already follows any in-flight event, so a
forced refresh that arrives during a build waits for that build.

Update the `media_refresh_in_flight` docstring to say "building or refreshing".
Add a comment on `_PREVIEW_BUILD_FOLLOW_WAIT_SEC`: it's longer than a normal
extract plus probes, and shorter than the extract gate's 180 s queue timeout.

- [ ] **Step 4: Run the tests to check they pass**

Run: `cd backend && pytest tests/test_stream_preview.py tests/test_preview_media_refresh.py -q`
Expected: all pass.

Run: `cd backend && ruff check app tests && ruff format --check app tests && mypy`
Expected: clean.

- [ ] **Step 5: Add a `### Fixed` changelog entry and commit**

Write the entry in user terms: opening a stream in two tabs, or after a hover,
could stop playback with errors.

```bash
git add backend/app/services/stream_preview.py backend/tests/test_stream_preview.py CHANGELOG.md
git commit  # "Build a stream's manifest once when asked twice at once"
```

The body says the second build evicted the first's token, so the player got
404s.

---

### Task 2: The warm-up core

**Files:**
- Modify: `frontend/src/utils/watchHref.ts`
- Create: `frontend/src/utils/watchHref.test.ts`
- Modify: `frontend/src/api/downloads.ts` (next to `getPreviewMeta`)
- Create: `frontend/src/queries/streamWarmup.ts`
- Create: `frontend/src/queries/streamWarmup.test.ts`

**Interfaces:**
- Consumes: `api.getPreviewMeta(url, { signal })`, `previewManifestUrl(url)`,
  `send()` from `api/client.ts`, `queryKeys.preview.meta(url)`, and
  `StreamPreviewMeta` from `types.ts`.
- Produces:
  - `streamUrlFromHref(href: string | null | undefined): string | null`
    returns the `url` query param of a `/watch?…` href and null for anything
    else (`/watch/12`, `/watch?channel=x`, null).
  - `api.warmPreviewManifest(url: string): Promise<void>` sends a GET of
    `previewManifestUrl(url)` through `send()` and discards the body. A
    non-2xx reply throws, as `send` does.
  - In `queries/streamWarmup.ts`:
    ```ts
    export const WARM_DWELL_MS = 120;
    export const WARM_REPEAT_MS = 180_000;
    export interface WarmDeps {
      fetchMeta(url: string): Promise<Pick<StreamPreviewMeta, "is_live" | "library_video_id">>;
      fetchManifest(url: string): Promise<void>;
      now(): number;
    }
    export class StreamWarmer {
      constructor(deps: WarmDeps);
      rest(url: string): void;   // warm after WARM_DWELL_MS unless leave() or another rest() comes first
      leave(): void;             // cancel the pending dwell, whatever its url
      warm(url: string): void;   // warm now (mouse button down)
      idle(): Promise<void>;     // settles once nothing runs or waits (tests)
    }
    export function streamWarmer(client: QueryClient): StreamWarmer;
    ```
    `streamWarmer` keeps one warmer per client in a `WeakMap`. Its
    `fetchMeta` is `client.fetchQuery({ queryKey: queryKeys.preview.meta(url),
    queryFn: ({ signal }) => api.getPreviewMeta(url, { signal }), staleTime:
    WARM_REPEAT_MS })`, its `fetchManifest` is `api.warmPreviewManifest`, and
    its `now` is `Date.now`.

- [ ] **Step 1: Write the failing tests**

`utils/watchHref.test.ts`, a test named
`streamUrlFromHref reads the stream link only`:

```ts
expect(streamUrlFromHref("/watch?url=https%3A%2F%2Fy.test%2Fw%3Fv%3D1&channel=C")).toBe("https://y.test/w?v=1");
expect(streamUrlFromHref("/watch/12")).toBeNull();
expect(streamUrlFromHref("/watch?channel=C")).toBeNull();
expect(streamUrlFromHref(null)).toBeNull();
```

`queries/streamWarmup.test.ts` covers the spec's "a quick sweep warms only the
last card" case. It lives here, not in Playwright, because in Playwright a
sweep's timing depends on how fast the commands run. It uses
`vi.useFakeTimers()`, a fake `now`, and deferred promises for `fetchMeta`, and
checks calls after
`await vi.advanceTimersByTimeAsync(...)` / `await warmer.idle()`:

- `rest warms after 120 ms`: after `rest(A)`, nothing at 119 ms, and
  `fetchMeta(A)` at 120 ms.
- `leaving before the dwell ends cancels it`: `rest(A)`, 100 ms, `leave()`,
  200 ms; no call.
- `a second rest replaces the first`: `rest(A)`, 60 ms, `rest(B)`, 120 ms;
  only `B`.
- `warm starts at once`: `warm(A)`; `fetchMeta(A)` called before any timer
  advance.
- `the manifest follows the details unless live or downloaded`: the details
  are `{is_live:false, library_video_id:null}`, `{is_live:true, …}` and
  `{is_live:false, library_video_id:7}`; `fetchManifest` is called for the
  first URL only.
- `one at a time and the newest pending wins`:
  - `warm(A)` with its `fetchMeta` held;
  - `warm(B)`, then `warm(C)`;
  - resolve `A`;
  - `fetchMeta` calls are `[A, C]`.
- `a url warmed within 3 minutes is skipped`:
  - `warm(A)`, idle, `warm(A)`: one call;
  - advance the fake `now` by `180_001`, `warm(A)`: two calls.
- `a failed warm-up can be retried at once`: `fetchMeta` rejects, idle,
  `warm(A)`: two calls.
- `warming the url already running or pending does nothing`:
  - `warm(A)` held, `warm(A)`, `warm(B)`, `warm(B)`;
  - resolve all;
  - calls are `[A, B]`.

- [ ] **Step 2: Run the tests to check they fail**

Run: `cd frontend && npx vitest run src/utils/watchHref.test.ts src/queries/streamWarmup.test.ts`
Expected: FAIL (the modules don't export these names).

- [ ] **Step 3: Implement** `streamUrlFromHref`, `api.warmPreviewManifest`,
  `StreamWarmer` and `streamWarmer`

`StreamWarmer` holds:
- the dwell timer;
- `running: string | null` and `pending: string | null`;
- `recent: Map<string, number>` (URL → start time), pruned of entries older
  than `WARM_REPEAT_MS` on each `warm`.

A run records `recent`, awaits `fetchMeta`, conditionally awaits
`fetchManifest`, deletes `recent` on any error, then starts `pending`. Errors
are swallowed: a warm-up is best-effort.

- [ ] **Step 4: Run the tests and gates**

Run: `cd frontend && npx vitest run src/utils/watchHref.test.ts src/queries/streamWarmup.test.ts && npm run lint && npm run typecheck && npx prettier --check src`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/watchHref.ts frontend/src/utils/watchHref.test.ts frontend/src/api/downloads.ts frontend/src/queries/streamWarmup.ts frontend/src/queries/streamWarmup.test.ts
git commit  # "Add a one-at-a-time warmer for stream details and manifests"
```

---

### Task 3: Warm feed cards on hover; the watch page opens on warmed details

**Files:**
- Create: `frontend/src/hooks/useStreamWarmup.ts`
- Modify: `frontend/src/components/ChannelFeedCard.tsx` (root `div` near
  line 570)
- Modify: `frontend/src/pages/watch/useWatchVideo.ts` (meta `useQuery` near
  line 126)
- Create: `frontend/e2e/stream-warmup.spec.ts`

**Interfaces:**
- Consumes: `streamWarmer`, `WARM_REPEAT_MS` and `streamUrlFromHref` (Task 2).
- Produces:
  ```ts
  export type StreamWarmupHandlers = Pick<
    React.HTMLAttributes<HTMLElement>,
    "onPointerEnter" | "onPointerLeave" | "onPointerDown" | "onFocus" | "onBlur"
  >;
  /** One call per component; the returned function gives each card its handlers. */
  export function useStreamWarmup(): (href: string | null) => StreamWarmupHandlers;
  ```
  For a non-stream href it returns `{}`.
  - **Mouse `pointerenter`** → `rest(url)`.
  - **`pointerleave`** → `leave()`.
  - **Mouse `pointerdown`** → `warm(url)`.
  - **`focus`** whose `event.target` matches `:focus-visible` → `rest(url)`.
  - **`blur`** → `leave()`.
  - **Unmount** calls `leave()`.

- [ ] **Step 1: Write the failing e2e spec** `frontend/e2e/stream-warmup.spec.ts`

**Setup:**
- Stub a YouTube channel feed as `channel-live.spec.ts` does
  (`/api/channels`, `/api/channels/feed`, `/api/downloads/preview` → 502).
- `/api/live/channel` answers `{ live: null }`.
- The feed has uploads `A`, `B` and a live entry `L` (`live_status:
  "is_live"`).
- Route `/api/preview/meta?` and `/api/preview/manifest?` with counters keyed
  by the `url` param:
  - meta answers a `META` like `stream-watch.spec.ts`'s, with `id`, `title`,
    `source_url`, `is_live: url === L.url` and `library_video_id: null`;
  - manifest answers 404 (no media in e2e).
- Skip on `isMobile`: hover is a pointer feature.

**Tests:**
- `hovering a stream card loads its details and manifest before the click`:
  - `feedCard(page, A.title).hover()`;
  - `expect.poll` until meta[A] is 1 and manifest[A] is 1;
  - click the card, and wait for the watch page to show A's title;
  - meta[A] is still 1.
- `a click right after mouse-down shares the request`:
  - meta is routed with a 300 ms delay;
  - `feedCard(page, B.title).click()` with no prior hover;
  - after the title shows, meta[B] is 1.
- `a live card warms its details but not a manifest`:
  - hover `L`;
  - poll until meta[L] is 1, wait 300 ms;
  - manifest[L] is 0.
- `touch does not warm`:
  - on `A`'s card, `dispatchEvent("pointerover", { pointerType: "touch",
    bubbles: true })` then `dispatchEvent("pointerdown", { pointerType:
    "touch", bubbles: true })`;
  - wait 400 ms;
  - meta[A] is 0.
- `a failed warm-up does not stop the click`:
  - the first meta request for `A` answers 502, later ones 200;
  - hover `A`, poll until meta[A] is 1;
  - click, the title shows;
  - meta[A] is 2.
- `coming back to a warmed video asks again`:
  - hover `A`, then click, the title shows;
  - `page.goBack()`, click `A` again, the title shows;
  - meta[A] is 2.

- [ ] **Step 2: Run the spec to check it fails**

Run: `cd frontend && npx playwright test e2e/stream-warmup.spec.ts --project app --trace off`
Expected: the hover tests fail (meta[A] stays 0 before the click).
`touch does not warm` passes already.

- [ ] **Step 3: Implement `useStreamWarmup` and wire `ChannelFeedCard`**

Call the hook once in `ChannelFeedCard` and spread `warmup(href)` on the root
`div`: hovering anywhere on the card counts, like TubeHaus. No other change to
the card.

- [ ] **Step 4: Make the watch page open on warmed details**

In `useWatchVideo`:
- The meta `useQuery` gets `staleTime: WARM_REPEAT_MS`, so a warmed entry is
  used as it is. No refetch on mount means no second `setSource` →
  `playStream`.
- Add an effect keyed on `[streamMode, streamUrlParam, queryClient]`. Its
  cleanup runs
  `queryClient.invalidateQueries({ queryKey: queryKeys.preview.meta(streamUrlParam), exact: true, refetchType: "none" })`,
  so leaving the page marks the details stale and the next visit asks again.

- [ ] **Step 5: Run the spec, the related unit tests and the gates**

Run: `cd frontend && npx playwright test e2e/stream-warmup.spec.ts e2e/stream-watch.spec.ts e2e/channel-live.spec.ts --trace off`
Expected: PASS in both projects (the hover tests are skipped on mobile).

Run: `cd frontend && npm run lint && npm run typecheck && npx prettier --check src e2e && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useStreamWarmup.ts frontend/src/components/ChannelFeedCard.tsx frontend/src/pages/watch/useWatchVideo.ts frontend/e2e/stream-warmup.spec.ts
git commit  # "Warm a stream when the pointer rests on its feed card"
```

The body covers the 120 ms dwell, one warm-up at a time, and the watch page
reusing the warmed details.

---

### Task 4: Warm every other stream link; docs

**Files:**
- Modify: `frontend/src/pages/watch/WatchSidebar.tsx`. In `WatchSidebar`,
  spread the handlers on the row `div` with `data-horde="related-item"`. In
  `StreamRelatedGrid`, spread them on the `Link`.
- Modify: `frontend/src/components/PlaylistRow.tsx` (the entry `Link` near
  line 838)
- Modify: `frontend/src/components/LiveNowSection.tsx` (the row `button`; its
  href is the `/watch?url=…&channel=…` it navigates to)
- Modify: `frontend/src/components/takeout/RewatchedSuggestions.tsx` (the
  `li`)
- Modify: `frontend/e2e/stream-watch.spec.ts`
- Modify: `docs/guides/watching.md`, `docs/design/player-architecture.md`,
  `docs/ops/youtube-access.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `useStreamWarmup()` (Task 3).

- [ ] **Step 1: Write the failing e2e test** in `stream-watch.spec.ts`

`hovering a not-downloaded related video warms it`:
- desktop only (skip on `isMobile`);
- `mockStream(page, [rem1])`, plus counting routes for meta and manifest
  registered after it, so they're matched first; meta answers `META` with
  `source_url` set to the requested URL;
- `goto(WATCH)`;
- hover the sidebar row `aside [data-horde='related-item']` for rem1;
- poll until meta for rem1's URL is 1 and manifest for it is 1.

- [ ] **Step 2: Run it to check it fails**

Run: `cd frontend && npx playwright test e2e/stream-watch.spec.ts -g "warms it" --project app --trace off`
Expected: FAIL (count stays 0).

- [ ] **Step 3: Wire the five surfaces**

Call the hook once per component and spread `warmup(item.href)` (or the href
the element opens) as listed under Files. Library links get `{}` from the hook,
so no conditionals are needed.

- [ ] **Step 4: Update the docs and changelog**

- `docs/guides/watching.md`: a section `## Starting a stream sooner`. Resting
  the pointer on a video that isn't downloaded, or tabbing to it, starts
  loading it, so a click plays sooner. It's one video at a time, and phones and
  tablets don't do it.
- `docs/design/player-architecture.md`, under "Shaka DASH for stream
  preview": warm-ups prefetch the details query and the manifest through the
  existing endpoints (no warm endpoint), and the manifest is built once per
  video at a time.
- `docs/ops/youtube-access.md`, under "Extract gate": hover warm-ups are
  interactive lookups, one at a time per tab, each video at most once every
  3 minutes, and never on touch.
- `CHANGELOG.md` `[Unreleased]` → `### Added`, an entry headed **Streams start
  sooner** in the house style.

- [ ] **Step 5: Run the tests and gates**

Run: `cd frontend && npx playwright test e2e/stream-watch.spec.ts e2e/stream-warmup.spec.ts e2e/watch-features.spec.ts --trace off && npm run lint && npm run typecheck && npx prettier --check src e2e`
Expected: PASS and clean.

Run: `cd /home/user/horde && mkdocs build --strict` (or the docs step of
`scripts/check.sh`).
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/watch/WatchSidebar.tsx frontend/src/components/PlaylistRow.tsx frontend/src/components/LiveNowSection.tsx frontend/src/components/takeout/RewatchedSuggestions.tsx frontend/e2e/stream-watch.spec.ts docs/guides/watching.md docs/design/player-architecture.md docs/ops/youtube-access.md CHANGELOG.md
git commit  # "Warm related, playlist, live and Takeout stream links"
```

---

### Task 5: Full gate and independent review

- [ ] **Step 1: Run the whole gate**

Run: `cd /home/user/horde && E2E_SHARDS=4 scripts/check.sh --e2e`
Expected: every step passes. A failure is fixed in the code, not by editing a
test, unless the test itself is wrong.

- [ ] **Step 2: Independent review.** This change touches concurrency and a
  multi-file feature. Dispatch one reviewer on the most capable model with
  this brief: assume it's broken, and require proof that it works. It reads
  the spec, this plan and `git diff main...HEAD`. Fix its findings. Re-review
  only if the fixes are large.

- [ ] **Step 3: Push**

```bash
git push -u origin claude/modest-franklin-apq5jd
```
