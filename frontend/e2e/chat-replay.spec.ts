import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import { expectNoSeriousViolations } from "./axe";

/**
 * Live chat replay on past streams. YouTube is never reached: the chat route
 * is mocked with made-up messages, and Cedar Notes (seeded with a YouTube link
 * and real, playable media) is presented as a past stream.
 */

const CEDAR_YT = "e2ecedar001";
/** The seeded media is about 20 s long. */
const DURATION_MS = 20_000;
const WINDOW_MS = 8_000;

type ChatOpts = {
  /** Milliseconds between made-up messages. */
  spacing?: number;
  /** Answer every read with this instead (none, unavailable, or an error). */
  answer?: (route: Route) => Promise<void>;
  /** Hold every answer until this resolves. */
  hold?: Promise<void>;
};

async function libraryId(page: Page, title: string): Promise<number> {
  const list = await page.request.get("/api/videos?limit=500");
  const item = (await list.json()).items.find(
    (v: { title: string }) => v.title === title
  );
  return item.id;
}

function message(offset: number) {
  return {
    id: `m${offset}`,
    offset_ms: offset,
    kind: "text",
    author: "Viewer",
    badges: [],
    runs: [{ text: `message at ${(offset / 1000).toFixed(1)}s` }],
  };
}

/** Made-up chat from `startMs`, one window long, like YouTube's chunks. */
function chunk(startMs: number, spacing: number) {
  const start = Math.max(0, Math.floor(startMs / spacing) * spacing);
  const end = Math.min(DURATION_MS, start + WINDOW_MS);
  const items = [];
  for (let o = start; o <= end; o += spacing) items.push(message(o));
  // One Super Chat and one moderator in the first stretch.
  if (start === 0) {
    items.push({
      ...message(250),
      id: "paid",
      kind: "paid",
      author: "Bo",
      amount: "$5.00",
      color: "#1de9b6",
      runs: [{ text: "great stream" }],
    });
    items.push({
      ...message(750),
      id: "mod",
      author: "Mo",
      badges: ["moderator"],
    });
    items.sort((a, b) => a.offset_ms - b.offset_ms);
  }
  return {
    status: "ok",
    items,
    next_cursor: end < DURATION_MS ? `${end}~T${end}` : null,
  };
}

/** Mock the chat route for Cedar Notes; returns the reads made. */
async function mockChat(page: Page, opts: ChatOpts = {}) {
  const spacing = opts.spacing ?? 500;
  const reads: string[] = [];
  await page.route(
    new RegExp(`/api/chat-replay/youtube/${CEDAR_YT}\\?`),
    async (route) => {
      const url = new URL(route.request().url());
      reads.push(url.search);
      if (opts.hold) await opts.hold;
      if (opts.answer) return opts.answer(route);
      const cursor = url.searchParams.get("cursor");
      const at = Number(url.searchParams.get("at_ms") ?? 0);
      const start = cursor ? Number(cursor.split("~")[0]) : at - 3_000;
      await route.fulfill({ json: chunk(start, spacing) });
    }
  );
  return reads;
}

/** Present Cedar Notes as a past stream (`live_status: was_live`). */
async function asPastStream(page: Page, id: number) {
  await page.route(new RegExp(`/api/videos/${id}$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const video = await response.json();
    await route.fulfill({
      response,
      json: { ...video, live_status: "was_live" },
    });
  });
}

async function openCedar(page: Page, opts: ChatOpts = {}, query = "") {
  const id = await libraryId(page, "Cedar Notes");
  await asPastStream(page, id);
  const reads = await mockChat(page, opts);
  await page.goto(`/watch/${id}${query}`);
  return { id, reads };
}

function chatRegion(page: Page) {
  return page.getByRole("region", { name: "Live chat" });
}

function chatLog(page: Page) {
  return page.getByRole("log", { name: "Live chat messages" });
}

async function pauseAt(page: Page, sec: number) {
  await page
    .locator("video")
    .first()
    .evaluate((v: HTMLVideoElement, t) => {
      v.pause();
      v.currentTime = t;
    }, sec);
}

async function lastMessage(page: Page): Promise<string> {
  return (await chatLog(page).locator("[data-id]").last().textContent()) ?? "";
}

async function scrollState(page: Page) {
  return chatLog(page).evaluate((el) => ({
    top: el.scrollTop,
    fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));
}

test("standard view: chat tops the right column, related videos below it", async ({
  page,
}) => {
  await openCedar(page);
  const aside = page.locator("aside");
  const chat = aside.getByRole("region", { name: "Live chat" });
  await expect(chat).toBeVisible();
  await expect(chatLog(page)).toContainText("message at 0.0s");
  await expect(chatLog(page).locator("[data-kind='paid']")).toContainText(
    "$5.00"
  );
  const related = aside.getByRole("heading", { name: "More like this" });
  await expect(related).toBeVisible();
  const chatBox = (await chat.boundingBox())!;
  const relatedBox = (await related.boundingBox())!;
  expect(relatedBox.y).toBeGreaterThan(chatBox.y + chatBox.height - 1);
  // Comments stay under the video.
  await expect(
    page
      .getByRole("region", { name: /Comments/ })
      .locator("xpath=ancestor::aside")
  ).toHaveCount(0);
});

test("chat follows playback and a seek", async ({ page }) => {
  await openCedar(page);
  await expect(chatLog(page)).toBeVisible();
  await pauseAt(page, 15);
  await expect.poll(() => lastMessage(page)).toContain("message at 15.0s");
  await pauseAt(page, 1);
  await expect.poll(() => lastMessage(page)).toContain("message at 1.0s");
  await pauseAt(page, 6.2);
  await expect.poll(() => lastMessage(page)).toContain("message at 6.0s");
});

test("scrolling up pauses autoscroll until Jump to latest", async ({
  page,
}) => {
  await openCedar(page, { spacing: 100 });
  await pauseAt(page, 15);
  await expect.poll(() => lastMessage(page)).toContain("message at 15.0s");
  await expect
    .poll(() => scrollState(page).then((s) => s.fromBottom))
    .toBeLessThan(30);

  await chatLog(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  const jump = page.getByRole("button", { name: "Jump to latest" });
  await expect(jump).toBeVisible();

  // New messages keep arriving below; the list does not move.
  await page
    .locator("video")
    .first()
    .evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => lastMessage(page)).not.toContain("message at 15.0s");
  await page.waitForTimeout(500);
  expect((await scrollState(page)).top).toBeLessThan(30);
  await page
    .locator("video")
    .first()
    .evaluate((v: HTMLVideoElement) => v.pause());

  await jump.click();
  await expect
    .poll(() => scrollState(page).then((s) => s.fromBottom))
    .toBeLessThan(30);
  await expect(jump).toHaveCount(0);
});

test("theater: chat beside the description", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("horde-e2e-theater")) return;
    sessionStorage.setItem("horde-e2e-theater", "1");
    localStorage.setItem(
      "horde.settings",
      JSON.stringify({ playbackMode: "theater" })
    );
  });
  await openCedar(page);
  const chat = chatRegion(page);
  await expect(chat).toBeVisible();
  await expect(page.locator("aside")).toHaveCount(0);
  const comments = page.getByRole("region", { name: /Comments/ });
  const chatBox = (await chat.boundingBox())!;
  const commentsBox = (await comments.boundingBox())!;
  // Side by side: chat to the right of the column the comments are in.
  expect(chatBox.x).toBeGreaterThan(commentsBox.x + commentsBox.width - 1);
});

for (const size of [
  { name: "narrow desktop", viewport: { width: 1100, height: 800 } },
  { name: "phone portrait", viewport: { width: 390, height: 844 } },
]) {
  test(`${size.name}: chat sits above the AI panel and comments`, async ({
    page,
  }) => {
    await page.setViewportSize(size.viewport);
    await openCedar(page);
    const chat = chatRegion(page);
    await expect(chat).toBeVisible();
    await expect(
      page.locator("aside").getByRole("region", { name: "Live chat" })
    ).toHaveCount(0);
    const comments = page.getByRole("region", { name: /Comments/ });
    const chatBox = (await chat.boundingBox())!;
    const commentsBox = (await comments.boundingBox())!;
    expect(commentsBox.y).toBeGreaterThan(chatBox.y + chatBox.height - 1);
  });
}

test("hide is remembered and the bar brings it back", async ({ page }) => {
  const { id } = await openCedar(page);
  const chat = chatRegion(page);
  await expect(chat).toBeVisible();
  await chat.getByRole("button", { name: "Hide" }).click();
  await expect(chat).toHaveCount(0);
  const bar = page.getByRole("button", { name: "Show live chat" });
  await expect(bar).toBeVisible();
  // Related videos are back at the top of the column.
  await expect(
    page.locator("aside").getByRole("heading", { name: "More like this" })
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Show live chat" })
  ).toBeVisible();
  await expect(chatRegion(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Show live chat" }).click();
  await expect(chatRegion(page)).toBeVisible();

  // The same switch is in Settings → Playback.
  await chatRegion(page).getByRole("button", { name: "Hide" }).click();
  await page.goto("/settings?tab=playback");
  const row = page.getByText("Show live chat on past streams");
  await expect(row).toBeVisible();
  await page
    .getByRole("switch", { name: "Show live chat on past streams" })
    .click();
  await page.goto(`/watch/${id}`);
  await expect(chatRegion(page)).toBeVisible();
});

test("no chat replay: the page keeps its usual layout", async ({ page }) => {
  await openCedar(page, {
    answer: (route) =>
      route.fulfill({ json: { status: "none", items: [], next_cursor: null } }),
  });
  await expect(
    page.locator("aside").getByRole("heading", { name: "More like this" })
  ).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(chatRegion(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show live chat" })
  ).toHaveCount(0);
});

test("a rate limit shows one note and no request storm", async ({ page }) => {
  let limited = true;
  const { reads } = await openCedar(page, {
    answer: (route) =>
      limited
        ? route.fulfill({
            status: 503,
            json: {
              detail: "YouTube is limiting requests; try again later",
              code: "youtube_rate_limited",
            },
          })
        : route.fulfill({ json: chunk(0, 500) }),
  });
  const chat = chatRegion(page);
  await expect(chat).toContainText("YouTube is limiting requests right now.");
  const count = reads.length;
  await page.waitForTimeout(3000);
  expect(reads.length).toBe(count);

  limited = false;
  await chat.getByRole("button", { name: "Retry" }).click();
  await expect(chatLog(page)).toContainText("message at 0.0s");
});

test("switching videos never shows the previous video's chat", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openCedar(page, { hold });
  await expect(chatRegion(page)).toBeVisible(); // loading
  await page
    .locator("aside")
    .getByRole("link", { name: "Aurora Drift" })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Aurora Drift" }).first()
  ).toBeVisible();
  release();
  await page.waitForTimeout(1000);
  await expect(chatRegion(page)).toHaveCount(0);
  await expect(page.getByText("message at 0.0s")).toHaveCount(0);
});

for (const status of ["was_live", "post_live"] as const) {
  test(`a streamed ${status} video ${status === "was_live" ? "gets" : "does not get"} chat`, async ({
    page,
  }) => {
    const yt = "strmchat001";
    const url = `https://www.youtube.com/watch?v=${yt}`;
    await page.route(/\/api\/preview\/meta\?/, (route) =>
      route.fulfill({
        json: {
          id: yt,
          title: "A past stream",
          channel: "Test Channel",
          channel_url: null,
          description: "",
          duration: 7200,
          thumbnail_url: null,
          source_url: url,
          library_video_id: null,
          subtitles: [],
          available_presets: [],
          view_count: 10,
          was_live: true,
          live_status: status,
        },
      })
    );
    await page.route(/\/api\/preview\/(manifest|stream|subtitles)\?/, (route) =>
      route.fulfill({ status: 404, json: { detail: "no media", code: "x" } })
    );
    await page.route(/\/api\/preview\/related\?/, (route) =>
      route.fulfill({ json: { items: [], next_cursor: null } })
    );
    const reads: string[] = [];
    await page.route(
      new RegExp(`/api/chat-replay/youtube/${yt}\\?`),
      (route) => {
        reads.push(route.request().url());
        return route.fulfill({ json: chunk(0, 500) });
      }
    );
    await page.goto(`/watch?url=${encodeURIComponent(url)}`);
    await expect(
      page.getByRole("heading", { name: "A past stream" }).first()
    ).toBeVisible();
    if (status === "was_live") {
      await expect(chatLog(page)).toContainText("message at 0.0s");
    } else {
      await page.waitForTimeout(1000);
      await expect(chatRegion(page)).toHaveCount(0);
      expect(reads).toEqual([]);
    }
  });
}

test("chat replay passes axe", async ({ page }) => {
  await openCedar(page);
  await expect(chatLog(page)).toContainText("message at 0.0s");
  await expectNoSeriousViolations(page, "watch with chat replay");
});
