import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import { expectNoSeriousViolations } from "./axe";

/**
 * Live chat beside a broadcast that is live now. The broadcast, its playlists
 * and its chat are mocked; nothing reaches YouTube.
 */

const ID = "livechat001";
const STREAM_URL = `https://www.youtube.com/watch?v=${ID}`;
const T0 = 1_763_740_800_000;

function message(id: string, text: string, offset = T0) {
  return {
    id,
    offset_ms: offset,
    kind: "text",
    author: "Viewer",
    badges: [],
    runs: [{ text }],
  };
}

function chatPage(
  items: unknown[],
  extra: Partial<{
    removed: string[];
    earliest_ms: number;
    cutoff_ms: number;
    status: string;
  }> = {}
) {
  return {
    status: "ok",
    items,
    removed: [],
    next_after: items.length,
    earliest_ms: T0 - 60_000,
    cutoff_ms: T0,
    ...extra,
  };
}

/** A live broadcast whose chat answers each read with the next of `answers`. */
async function openLive(
  page: Page,
  answers: ((route: Route) => Promise<void>)[]
) {
  const reads: string[] = [];
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({
      json: {
        id: ID,
        title: "On air now",
        channel: "Test Channel",
        channel_url: null,
        description: "",
        duration: null,
        thumbnail_url: null,
        source_url: STREAM_URL,
        library_video_id: null,
        subtitles: [],
        available_presets: [],
        view_count: 10,
        is_live: true,
      },
    })
  );
  await page.route(/\/api\/live\/[^/]+\/(master|v|seg)\b/, (route) =>
    route.fulfill({ status: 404, json: { detail: "no media", code: "x" } })
  );
  await page.route(
    /\/api\/preview\/(manifest|stream|subtitles|related)\?/,
    (route) =>
      route.fulfill({ status: 404, json: { detail: "no media", code: "x" } })
  );
  await page.route(new RegExp(`/api/live/${ID}/chat\\?`), async (route) => {
    reads.push(new URL(route.request().url()).search);
    const answer = answers[Math.min(reads.length - 1, answers.length - 1)];
    await answer(route);
  });
  await page.goto(`/watch?url=${encodeURIComponent(STREAM_URL)}`);
  return reads;
}

const json = (body: unknown) => (route: Route) => route.fulfill({ json: body });

function chatLog(page: Page) {
  return page.getByRole("log", { name: "Live chat messages" });
}

test("a live stream shows its live chat, asked at the moment being watched", async ({
  page,
}) => {
  const reads = await openLive(page, [
    json(chatPage([message("a", "hello live")])),
  ]);
  await expect(chatLog(page)).toContainText("hello live");
  await expect(page.getByRole("region", { name: "Live chat" })).toBeVisible();
  expect(reads[0]).toContain("behind_ms=");
  expect(reads[0]).toContain("after=0");
  // It keeps reading, after the last message it has.
  await expect.poll(() => reads.length).toBeGreaterThan(1);
  expect(reads[1]).toContain("after=1");
});

test("a message deleted on YouTube disappears", async ({ page }) => {
  await openLive(page, [
    json(chatPage([message("a", "spam spam"), message("b", "nice")])),
    json(chatPage([], { removed: ["a"] })),
  ]);
  await expect(chatLog(page)).toContainText("spam spam");
  await expect(chatLog(page)).not.toContainText("spam spam");
  await expect(chatLog(page)).toContainText("nice");
});

test("chat older than Horde holds says so", async ({ page }) => {
  await openLive(page, [
    json(chatPage([], { earliest_ms: T0, cutoff_ms: T0 - 3_600_000 })),
  ]);
  await expect(
    page.getByText(/Chat from before \d\d:\d\d isn't available\./)
  ).toBeVisible();
});

test("a broadcast without chat shows no panel", async ({ page }) => {
  const reads = await openLive(page, [
    json({
      status: "none",
      items: [],
      removed: [],
      next_after: 0,
      earliest_ms: null,
      cutoff_ms: T0,
    }),
  ]);
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  await page.waitForTimeout(2500);
  await expect(page.getByRole("region", { name: "Live chat" })).toHaveCount(0);
  expect(reads).toHaveLength(1);
});

test("live chat passes axe", async ({ page }) => {
  await openLive(page, [json(chatPage([message("a", "hello live")]))]);
  await expect(chatLog(page)).toContainText("hello live");
  await expectNoSeriousViolations(page, "watch a live stream with chat");
});
