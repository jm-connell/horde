# Chat Beside the Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In theater and fit window the live chat (and chat replay) sits to the right of the picture, and a small arrow at the top right of the picture opens it when it is hidden.

**Architecture:** The player already keeps an empty element beside the picture in touch fullscreen, and the watch page portals the chat into it. The player now offers that element in theater and fit window too; the watch page fills it and stops placing the chat under the video. The page hands the player an "opener" through `PlaybackActions`, which the player draws as the arrow.

**Tech Stack:** React 19, TypeScript, Tailwind 4, Vitest, Playwright. Frontend only: no API, schema or backend change.

**Spec:** `docs/superpowers/specs/2026-11-27-chat-beside-player-design.md`

## Global Constraints

- Beside the picture only on a window at least 1024px wide (`(min-width: 1024px)`), in theater or fit window, never on phones (`useIsMobile`).
- The slot is `min(24rem, 33%)` of the player wide.
- Desktop fullscreen stays video only. Standard view, phones, touch fullscreen and windows under 1024px behave as today.
- One switch: the arrow, the panel's **Hide**, the **Show live chat** bar and the setting are all `showChatReplay`. Arrow label: `Show live chat`.
- The player must not learn about chat: it gets an element to offer and an opener (`label`, `open`).
- Project rules (`CLAUDE.md`): no test weakened to get green; `DESIGN.md`, `docs/` and `CHANGELOG.md` updated in the same change; commits small, imperative subject under 72 characters.
- Run from `frontend/`. Unit: `npx vitest run <file>`. E2E: `npx playwright test e2e/chat-replay.spec.ts --trace off` (viewport 1440×900).

## Review Focus

1. **A long chat.** Hundreds of messages must not make the player taller than the picture; the list scrolls inside the panel. (Task 2 test.)
2. **Resizing under 1024px in theater.** The chat moves under the video and is on the page exactly once, never twice or not at all. (Task 2 test.)
3. **Desktop fullscreen from theater.** Video only while fullscreen; the chat is back beside the picture on exit. (Task 2 test.)
4. **A video with no chat.** Theater and fit window give the picture the whole width and show no arrow. (Task 3 test.)
5. **Leaving the watch page with the chat hidden.** The mini player shows no arrow. (Task 3 test.)

---

## File structure

- Create `frontend/src/components/player/playerAside.ts`: the one rule for "room beside the picture" and the opener type.
- Modify `frontend/src/components/VideoPlayer.tsx`, `videoPlayerTypes.ts`: offer the slot, draw the arrow.
- Modify `frontend/src/context/PlaybackContext.tsx`: carry the slot and the opener.
- Modify `frontend/src/pages/watch/chatReplay/model.ts`, `ChatReplayPanel.tsx`, `frontend/src/pages/Watch.tsx`, `frontend/src/pages/watch/WatchInfoPanels.tsx`: placement and wiring.
- Tests: `model.test.ts`, `components/player/playerPure.test.ts`, `e2e/chat-replay.spec.ts`.
- Docs: `DESIGN.md`, `docs/guides/watching.md`, `CHANGELOG.md`.

### Task 1: The placement rule

**Files:**
- Create: `frontend/src/components/player/playerAside.ts`
- Modify: `frontend/src/pages/watch/chatReplay/model.ts` (`ChatPlacement`, `chatPlacement`)
- Test: `frontend/src/components/player/playerPure.test.ts`, `frontend/src/pages/watch/chatReplay/model.test.ts`

**Interfaces:**
- Produces:
  - `PLAYER_ASIDE_QUERY = "(min-width: 1024px)"`
  - `besidePictureOnDesktop(mode: ViewMode, wide: boolean): boolean` (true for theater or windowed on a wide window)
  - `interface AsideOpener { label: string; open: () => void }`
  - `type ChatPlacement = "sidebar" | "beside-player" | "inline" | "sideways"`
  - `chatPlacement(o: { isMobile: boolean; landscape: boolean; besidePlayer: boolean; wide: boolean }): ChatPlacement` (`theater` is renamed `besidePlayer`; it returns `"beside-player"` where it returned `"beside-info"`)

- [ ] **Step 1: Write the failing tests**

`playerPure.test.ts`:

```ts
describe("besidePictureOnDesktop", () => {
  it("is theater or fit window on a wide window", () => {
    expect(besidePictureOnDesktop("theater", true)).toBe(true);
    expect(besidePictureOnDesktop("windowed", true)).toBe(true);
    expect(besidePictureOnDesktop("standard", true)).toBe(false);
    expect(besidePictureOnDesktop("theater", false)).toBe(false);
  });
});
```

`model.test.ts`, in "covers every layout": rename `theater` to `besidePlayer` in every call, expect `"beside-player"` for `{ isMobile: false, landscape: false, besidePlayer: true, wide: true }`, and add that a phone never gets it: `{ isMobile: true, landscape: false, besidePlayer: true, wide: false }` is `"inline"`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run src/components/player/playerPure.test.ts src/pages/watch/chatReplay/model.test.ts`
Expected: FAIL (`besidePictureOnDesktop` is not exported; `"beside-info"` received).

- [ ] **Step 3: Implement `playerAside.ts` and change `chatPlacement`**

- [ ] **Step 4: Run them and see them pass**

Same command. `Watch.tsx` will not typecheck until Task 2; that is expected within this task.

- [ ] **Step 5: Commit** (with Task 2, so every commit typechecks)

### Task 2: The chat in the player's slot

**Files:**
- Modify: `frontend/src/components/VideoPlayer.tsx:510-519,573-583,764-770`, `frontend/src/components/videoPlayerTypes.ts:116`
- Modify: `frontend/src/context/PlaybackContext.tsx` (`PlaybackLayout.fullscreenAside`, both `<VideoPlayer>`)
- Modify: `frontend/src/pages/watch/chatReplay/ChatReplayPanel.tsx` (`ChatPanelVariant`, `HEIGHT`)
- Modify: `frontend/src/pages/Watch.tsx`, `frontend/src/pages/watch/WatchInfoPanels.tsx`
- Test: `frontend/e2e/chat-replay.spec.ts`

**Interfaces:**
- Consumes: `PLAYER_ASIDE_QUERY`, `besidePictureOnDesktop`, `chatPlacement` (Task 1).
- Produces:
  - `VideoPlayerProps.onAside?: (el: HTMLElement | null) => void` (was `onFullscreenAside`)
  - `PlaybackLayout.playerAside: HTMLElement | null` (was `fullscreenAside`)
  - The slot's outer element: `data-horde="player-aside"` (was `player-fullscreen-aside`)
  - `ChatPanelVariant = "sidebar" | "inline" | "sideways" | "beside-player"`, with `"beside-player": "h-full w-full"`

- [ ] **Step 1: Write the failing e2e tests** in `chat-replay.spec.ts`

Add a `theater(page)` helper holding the init script the two theater tests repeat. Replace "theater: chat beside the description" with:

```ts
const playerAside = (page: Page) => page.locator("[data-horde='player-aside']");

test("theater: chat beside the picture, as tall as the player", async ({ page }) => {
  await theater(page);
  await openCedar(page, { spacing: 100 });
  await pauseAt(page, 8);
  const chat = playerAside(page).getByRole("region", { name: "Live chat" });
  await expect(chat).toBeVisible();
  await expect(chatRegion(page)).toHaveCount(1);
  // A long chat scrolls inside the panel instead of growing the player.
  await expect
    .poll(() => chatLog(page).evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  const video = (await page.locator("video").first().boundingBox())!;
  const box = (await chat.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(video.x + video.width - 1);
  expect(box.y).toBeGreaterThanOrEqual(video.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(video.y + video.height + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
});

test("fit window: chat beside the picture", async ({ page }) => {
  await openCedar(page);
  await expect(chatRegion(page)).toBeVisible();
  await page.keyboard.press("f");
  const chat = playerAside(page).getByRole("region", { name: "Live chat" });
  await expect(chat).toBeVisible();
  await expect(chatRegion(page)).toHaveCount(1);
  const video = (await page.locator("video").first().boundingBox())!;
  const box = (await chat.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(video.x + video.width - 1);
  expect(box.height).toBeGreaterThan(800);
  await page.keyboard.press("Escape");
  await expect(playerAside(page)).toHaveCount(0);
  await expect(chatRegion(page)).toBeVisible();
});

test("theater: a window narrowed under 1024px moves chat under the video", async ({ page }) => {
  await theater(page);
  await openCedar(page);
  await expect(playerAside(page).getByRole("region", { name: "Live chat" })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(playerAside(page)).toHaveCount(0);
  await expect(chatRegion(page)).toHaveCount(1);
  await expect(chatRegion(page)).toBeVisible();
});

test("theater: desktop fullscreen is video only, and chat returns after it", async ({ page }) => {
  await theater(page);
  await openCedar(page);
  await expect(playerAside(page).getByRole("region", { name: "Live chat" })).toBeVisible();
  const box = (await page.locator("video").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(playerAside(page)).toHaveCount(0);
  await page.evaluate(() => document.exitFullscreen());
  await expect(playerAside(page).getByRole("region", { name: "Live chat" })).toBeVisible();
});
```

In the two existing fullscreen tests, the locator becomes `player-aside`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx playwright test e2e/chat-replay.spec.ts --trace off -g "theater|fit window"`
Expected: FAIL (no `player-aside` element).

- [ ] **Step 3: Offer the slot from the player**

`showAside = !isMini && (isNativeFullscreen ? coarsePointer : besidePictureOnDesktop(mode, useMediaQuery(PLAYER_ASIDE_QUERY)))`. The wrapper gets `flex` while the slot is offered (theater's wrapper is a block today). The slot:

```tsx
<div
  data-horde="player-aside"
  className="relative w-[min(24rem,33%)] shrink-0 self-stretch has-[>:empty]:hidden"
>
  <div ref={asideRef} className="absolute inset-0 flex py-2 pr-2" />
</div>
```

The inner element is the portal target and is absolutely positioned so its content adds nothing to the row's height (Review Focus 1). Rename the prop and the context field.

- [ ] **Step 4: Fill it from the watch page**

`Watch.tsx`: `chatPlacement({ ..., besidePlayer: !isMobile && besidePictureOnDesktop(mode, asideWide), wide: wideScreen && mode === "standard" })`. With `beside-player`, a shown chat renders nowhere on the page; the existing portal (`playerAside && chatShown`) puts it in the slot with `variant="beside-player"`. `WatchInfoPanels` loses `chatBeside` and its column goes back to the queue alone (`queueBeside && <PlaybackQueue className="lg:sticky lg:top-20 lg:self-start" />`).

- [ ] **Step 5: Run the spec and the unit tests**

Run: `npx playwright test e2e/chat-replay.spec.ts e2e/live-chat.spec.ts --trace off` and `npm run typecheck && npx vitest run src/pages/watch src/components/player`
Expected: PASS.

- [ ] **Step 6: Commit** `Put live chat beside the picture in theater and fit window`

### Task 3: The arrow that opens it

**Files:**
- Modify: `frontend/src/context/PlaybackContext.tsx` (`PlaybackActions`, state, both `<VideoPlayer>`)
- Modify: `frontend/src/components/VideoPlayer.tsx`, `frontend/src/components/videoPlayerTypes.ts`
- Modify: `frontend/src/pages/Watch.tsx`
- Test: `frontend/e2e/chat-replay.spec.ts`

**Interfaces:**
- Consumes: `AsideOpener` (Task 1), the slot (Task 2).
- Produces:
  - `PlaybackActions.setAsideOpener: (opener: AsideOpener | null) => void`
  - `VideoPlayerProps.asideOpener?: AsideOpener | null`
  - The arrow: a `<button data-horde="player-aside-opener">` named by `opener.label`, at the top right of the picture (`absolute right-3 top-3`), a left `ArrowIcon` on `bg-black/55`, shown with the controls and on keyboard focus.

- [ ] **Step 1: Write the failing e2e tests**

```ts
const opener = (page: Page) => page.locator("[data-horde='player-aside-opener']");

async function overVideo(page: Page) {
  const box = (await page.locator("video").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test("theater: Hide gives the picture the width back and the arrow reopens chat", async ({ page }) => {
  await theater(page);
  await openCedar(page);
  const chat = playerAside(page).getByRole("region", { name: "Live chat" });
  await expect(chat).toBeVisible();
  await expect(opener(page)).toHaveCount(0);
  const before = (await page.locator("video").first().boundingBox())!.width;
  await chat.getByRole("button", { name: "Hide" }).click();
  await expect(chatRegion(page)).toHaveCount(0);
  await expect.poll(async () => (await page.locator("video").first().boundingBox())!.width).toBeGreaterThan(before);
  await overVideo(page);
  await expect(opener(page)).toHaveAccessibleName("Show live chat");
  const video = (await page.locator("video").first().boundingBox())!;
  const arrow = (await opener(page).boundingBox())!;
  expect(arrow.x).toBeGreaterThan(video.x + video.width / 2);
  expect(arrow.y).toBeLessThan(video.y + video.height / 2);
  await opener(page).click();
  await expect(chat).toBeVisible();
  await expect(opener(page)).toHaveCount(0);
});

test("fit window: the arrow opens a hidden chat", async ({ page }) => {
  await openCedar(page);
  await chatRegion(page).getByRole("button", { name: "Hide" }).click();
  await expect(opener(page)).toHaveCount(0); // standard view has the bar
  await page.keyboard.press("f");
  await overVideo(page);
  await opener(page).click();
  await expect(playerAside(page).getByRole("region", { name: "Live chat" })).toBeVisible();
});

test("theater: a video with no chat has no arrow and the whole width", async ({ page }) => {
  await theater(page);
  await openCedar(page, { answer: (route) => route.fulfill({ json: { status: "none", items: [], next_cursor: null } }) });
  await expect(page.locator("video").first()).toBeVisible();
  await overVideo(page);
  await expect(opener(page)).toHaveCount(0);
  await expect(playerAside(page)).toBeHidden();
  expect((await page.locator("video").first().boundingBox())!.width).toBe(1440);
});

test("the mini player has no chat arrow", async ({ page }) => {
  await theater(page);
  await openCedar(page);
  await playerAside(page).getByRole("button", { name: "Hide" }).click();
  await overVideo(page);
  await expect(opener(page)).toBeVisible();
  await page.getByRole("link", { name: "Library" }).first().click();
  await expect(page.locator(".player-mini")).toBeVisible();
  await expect(opener(page)).toHaveCount(0);
});
```

(If the "no chat" answer's shape or the Library link's name differ in the existing spec, use the ones the neighbouring tests use.)

- [ ] **Step 2: Run them and see them fail**

Run: `npx playwright test e2e/chat-replay.spec.ts --trace off -g "arrow"`
Expected: FAIL (no `player-aside-opener`).

- [ ] **Step 3: Carry the opener and draw the arrow**

`PlaybackProvider` holds `asideOpener` in state (`setAsideOpener` is the state setter, like `setClipMarkers`) and passes it to both players. `VideoPlayer` draws the arrow inside the stage when `showAside && asideOpener`.

- [ ] **Step 4: Set it from the watch page**

`Watch.tsx`, in an effect above the early returns: while the chat is hidden (`chatFor.known && !settings.showChatReplay`) and the placement is `beside-player`, `setAsideOpener({ label: "Show live chat", open: showChat })`; the cleanup sets `null`. In theater a hidden chat also keeps a **Show live chat** bar first in the column under the video (`chatInline`).

- [ ] **Step 5: Run the spec**

Run: `npx playwright test e2e/chat-replay.spec.ts e2e/live-chat.spec.ts e2e/player.spec.ts --trace off`
Expected: PASS.

- [ ] **Step 6: Commit** `Open a hidden chat from an arrow on the picture`

### Task 4: Docs, gate and review

**Files:**
- Modify: `DESIGN.md` (Live chat replay component; the watch page layout line that names the theater column)
- Modify: `docs/guides/watching.md` (Live chat replay: where it sits; Hide)
- Modify: `CHANGELOG.md` (`[Unreleased]` → Changed)

- [ ] **Step 1:** Describe the new placement and the arrow in the three files; no em dashes, the interface words as the app shows them (**Hide**, **Show live chat**, Theater, Fit window).
- [ ] **Step 2:** Run `E2E_SHARDS=4 scripts/check.sh --e2e` from the repo root. Expected: every gate green.
- [ ] **Step 3:** One independent critical review of the branch diff (assume it is broken; require proof), then fix its findings.
- [ ] **Step 4: Commit** `Document chat beside the player` and push.
