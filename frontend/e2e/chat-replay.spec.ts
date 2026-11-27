import type { Page, Route } from "@playwright/test";
import { expect, openNav, test } from "./fixtures";
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

/** Open in theater (once: later reloads keep whatever the test chose). */
async function theater(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("horde-e2e-theater")) return;
    sessionStorage.setItem("horde-e2e-theater", "1");
    localStorage.setItem(
      "horde.settings",
      JSON.stringify({ playbackMode: "theater" })
    );
  });
}

/** The player's own room beside the picture (theater, fit window). */
function playerAside(page: Page) {
  return page.locator("[data-horde='player-aside']");
}

/** The arrow on the picture that opens a hidden chat beside it. */
function opener(page: Page) {
  return page.locator("[data-horde='player-aside-opener']");
}

/** Bring the player's controls up. */
async function overVideo(page: Page) {
  const box = (await page.locator("video").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
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

test("theater: chat beside the picture, as tall as the player", async ({
  page,
}) => {
  await theater(page);
  await openCedar(page, { spacing: 100 });
  await pauseAt(page, 8);
  const chat = playerAside(page).getByRole("region", { name: "Live chat" });
  await expect(chat).toBeVisible();
  await expect(chatRegion(page)).toHaveCount(1);
  // A long chat scrolls inside the panel instead of growing the player.
  await expect
    .poll(() =>
      chatLog(page).evaluate((el) => el.scrollHeight > el.clientHeight)
    )
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
  // The whole height of the window, once the player has grown to fill it.
  await expect
    .poll(async () => (await chat.boundingBox())!.height)
    .toBeGreaterThan(890);
  const video = (await page.locator("video").first().boundingBox())!;
  const box = (await chat.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(video.x + video.width - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  await page.keyboard.press("Escape");
  await expect(playerAside(page)).toHaveCount(0);
  await expect(chatRegion(page)).toBeVisible();
});

test("theater: a window narrowed under 1024px moves chat under the video", async ({
  page,
}) => {
  await theater(page);
  await openCedar(page);
  await expect(
    playerAside(page).getByRole("region", { name: "Live chat" })
  ).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(playerAside(page)).toHaveCount(0);
  await expect(chatRegion(page)).toHaveCount(1);
  await expect(chatRegion(page)).toBeVisible();
});

test("theater: desktop fullscreen is video only, and chat returns after it", async ({
  page,
}) => {
  await theater(page);
  await openCedar(page);
  const chat = playerAside(page).getByRole("region", { name: "Live chat" });
  await expect(chat).toBeVisible();
  const box = (await page.locator("video").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement !== null))
    .toBe(true);
  await expect(playerAside(page)).toHaveCount(0);
  await page.evaluate(() => document.exitFullscreen());
  await expect(chat).toBeVisible();
});

test("theater to fit window and back keeps following the newest message", async ({
  page,
}) => {
  await theater(page);
  await openCedar(page, { spacing: 100 });
  await pauseAt(page, 15);
  const chat = playerAside(page).getByRole("region", { name: "Live chat" });
  const jump = page.getByRole("button", { name: "Jump to latest" });
  await expect.poll(() => lastMessage(page)).toContain("message at 15.0s");
  await expect
    .poll(() => scrollState(page).then((s) => s.fromBottom))
    .toBeLessThan(30);

  // Fit window moves the player (and the chat in it) to cover the page.
  await page.keyboard.press("f");
  await expect
    .poll(async () => (await chat.boundingBox())!.height)
    .toBeGreaterThan(890);
  await page.waitForTimeout(500);
  expect((await scrollState(page)).fromBottom).toBeLessThan(30);
  await expect(jump).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await chat.boundingBox())!.height)
    .toBeLessThan(800);
  await page.waitForTimeout(500);
  expect((await scrollState(page)).fromBottom).toBeLessThan(30);
  await expect(jump).toHaveCount(0);
});

test("theater to fit window keeps the place of someone reading back", async ({
  page,
}) => {
  await theater(page);
  await openCedar(page, { spacing: 100 });
  await pauseAt(page, 15);
  const chat = playerAside(page).getByRole("region", { name: "Live chat" });
  const jump = page.getByRole("button", { name: "Jump to latest" });
  await expect.poll(() => lastMessage(page)).toContain("message at 15.0s");
  const firstInView = () =>
    chatLog(page).evaluate((el) => {
      const row = Array.from(el.children).find(
        (c) => (c as HTMLElement).offsetTop >= el.scrollTop
      ) as HTMLElement;
      return row.dataset.id;
    });
  await chatLog(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  await expect(jump).toBeVisible();
  const reading = await firstInView();

  await page.keyboard.press("f");
  await expect
    .poll(async () => (await chat.boundingBox())!.height)
    .toBeGreaterThan(890);
  await page.waitForTimeout(500);
  await expect(jump).toBeVisible();
  expect(await firstInView()).toBe(reading);
});

test("theater: Hide gives the picture the width back and the arrow reopens chat", async ({
  page,
}) => {
  await theater(page);
  await openCedar(page);
  const chat = playerAside(page).getByRole("region", { name: "Live chat" });
  await expect(chat).toBeVisible();
  await expect(opener(page)).toHaveCount(0);
  const video = page.locator("video").first();
  const before = (await video.boundingBox())!.width;
  await chat.getByRole("button", { name: "Hide" }).click();
  await expect(chatRegion(page)).toHaveCount(0);
  await expect
    .poll(async () => (await video.boundingBox())!.width)
    .toBeGreaterThan(before);
  await overVideo(page);
  await expect(opener(page)).toHaveAccessibleName("Show live chat");
  // A small arrow in the picture's top right corner.
  const picture = (await video.boundingBox())!;
  const arrow = (await opener(page).boundingBox())!;
  expect(arrow.x).toBeGreaterThan(picture.x + picture.width - 80);
  expect(arrow.y).toBeLessThan(picture.y + 80);
  await opener(page).click();
  await expect(chat).toBeVisible();
  await expect(opener(page)).toHaveCount(0);
});

test("fit window: the arrow opens a hidden chat", async ({ page }) => {
  await openCedar(page);
  await chatRegion(page).getByRole("button", { name: "Hide" }).click();
  // Standard view has the bar in the chat's place, not the arrow.
  await expect(
    page.getByRole("button", { name: "Show live chat" })
  ).toBeVisible();
  await expect(opener(page)).toHaveCount(0);
  await page.keyboard.press("f");
  await overVideo(page);
  await opener(page).click();
  await expect(
    playerAside(page).getByRole("region", { name: "Live chat" })
  ).toBeVisible();
});

test("theater: a video with no chat has no arrow and the whole width", async ({
  page,
}) => {
  await theater(page);
  await openCedar(page, {
    answer: (route) =>
      route.fulfill({ json: { status: "none", items: [], next_cursor: null } }),
  });
  const video = page.locator("video").first();
  await expect(video).toBeVisible();
  await page.waitForTimeout(1000);
  await overVideo(page);
  await expect(opener(page)).toHaveCount(0);
  await expect(playerAside(page)).toBeHidden();
  expect((await video.boundingBox())!.width).toBe(1440);
});

test("the mini player has no chat arrow", async ({ page }) => {
  await theater(page);
  await openCedar(page);
  await playerAside(page).getByRole("button", { name: "Hide" }).click();
  await overVideo(page);
  await expect(opener(page)).toBeVisible();
  await page
    .locator("video")
    .first()
    .evaluate((v: HTMLVideoElement) => v.play());
  await openNav(page, "Home");
  await expect(page.locator(".player-mini")).toBeVisible();
  await expect(opener(page)).toHaveCount(0);
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
  const row = page.getByText("Show live chat", { exact: true });
  await expect(row).toBeVisible();
  await page.getByRole("switch", { name: /^Show live chat(?! on)/ }).click();
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

test.describe("phone turned sideways", () => {
  test.use({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
  });

  test("video and chat fill the screen side by side", async ({ page }) => {
    await openCedar(page);
    const chat = chatRegion(page);
    await expect(chat).toBeVisible();
    await expect(page.locator("[data-horde='watch-sideways']")).toBeVisible();
    const video = (await page.locator("video").first().boundingBox())!;
    const chatBox = (await chat.boundingBox())!;
    expect(chatBox.x).toBeGreaterThanOrEqual(video.x + video.width - 1);
    for (const box of [video, chatBox]) {
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(391);
    }
    expect(chatBox.width).toBeGreaterThan(844 * 0.25);
    expect(chatBox.width).toBeLessThan(844 * 0.4);
    // The page behind does not scroll.
    await page.evaluate(() => window.scrollTo(0, 500));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("hiding gives the whole screen to the video", async ({ page }) => {
    await openCedar(page);
    await chatRegion(page).getByRole("button", { name: "Hide" }).click();
    const show = page.getByRole("button", { name: "Show live chat" });
    await expect(show).toBeVisible();
    await expect(page.locator("[data-horde='watch-sideways']")).toBeVisible();
    const video = (await page.locator("video").first().boundingBox())!;
    expect(video.width).toBeGreaterThan(844 * 0.85);
    await show.click();
    await expect(chatRegion(page)).toBeVisible();
  });

  test("other videos turn sideways as before", async ({ page }) => {
    await page.goto(`/watch/${await libraryId(page, "Aurora Drift")}`);
    await expect(page.locator("video").first()).toBeVisible();
    await expect(page.locator("[data-horde='watch-sideways']")).toHaveCount(0);
  });
});

test.describe("touch screen fullscreen", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

  test("chat comes along beside the picture", async ({ page }) => {
    await openCedar(page);
    await expect(chatRegion(page)).toBeVisible();
    const box = (await page.locator("video").first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement !== null))
      .toBe(true);
    const aside = playerAside(page);
    await expect(
      aside.getByRole("region", { name: "Live chat" })
    ).toBeVisible();
    await page.evaluate(() => document.exitFullscreen());
    await expect(aside).toHaveCount(0);
  });
});

test("desktop fullscreen stays video only", async ({ page }) => {
  await openCedar(page);
  await expect(chatRegion(page)).toBeVisible();
  const box = (await page.locator("video").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement !== null))
    .toBe(true);
  await expect(playerAside(page)).toHaveCount(0);
  await page.evaluate(() => document.exitFullscreen());
});

test("a library video not known to be a stream shows nothing when YouTube is out of reach", async ({
  page,
}) => {
  const id = await libraryId(page, "Cedar Notes");
  await page.route(new RegExp(`/api/videos/${id}$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const video = await response.json();
    await route.fulfill({ response, json: { ...video, live_status: null } });
  });
  const reads = await mockChat(page, {
    answer: (route) =>
      route.fulfill({
        status: 503,
        json: {
          detail: "Could not reach YouTube; try again later",
          code: "youtube_unreachable",
        },
      }),
  });
  await page.goto(`/watch/${id}`);
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  await expect(chatRegion(page)).toHaveCount(0);
  await expect(page.getByText("Could not reach YouTube.")).toHaveCount(0);
});

test("theater on a tablet-sized window puts chat above the comments", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await theater(page);
  await openCedar(page);
  const chat = chatRegion(page);
  await expect(chat).toBeVisible();
  const comments = page.getByRole("region", { name: /Comments/ });
  const chatBox = (await chat.boundingBox())!;
  const commentsBox = (await comments.boundingBox())!;
  expect(commentsBox.y).toBeGreaterThan(chatBox.y + chatBox.height - 1);
});

test("a busy chat is not read aloud over the video", async ({ page }) => {
  await openCedar(page);
  await expect(chatLog(page)).toHaveAttribute("aria-live", "off");
});

test("switching between two past streams shows only the new one's chat", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { id: cedar } = await openCedar(page, { hold });
  const aurora = await libraryId(page, "Aurora Drift");
  await page.route(new RegExp(`/api/videos/${aurora}$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        source_url: "https://www.youtube.com/watch?v=auroradrft1",
        live_status: "was_live",
      },
    });
  });
  await page.route(/\/api\/chat-replay\/youtube\/auroradrft1\?/, (route) =>
    route.fulfill({
      json: {
        status: "ok",
        items: [
          { ...message(0), id: "aurora", runs: [{ text: "aurora chat" }] },
        ],
        next_cursor: null,
      },
    })
  );
  expect(cedar).not.toBe(aurora);
  await expect(chatRegion(page)).toBeVisible(); // Cedar's chat, still loading
  await page
    .locator("aside")
    .getByRole("link", { name: "Aurora Drift" })
    .first()
    .click();
  await expect(chatLog(page)).toContainText("aurora chat");
  release();
  await page.waitForTimeout(1000);
  await expect(chatLog(page)).toContainText("aurora chat");
  await expect(page.getByText("message at 0.0s")).toHaveCount(0);
});

test.describe("phone turned sideways, with a dialog over it", () => {
  test.use({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
  });

  test("leaving the sideways view never leaves the page stuck unscrollable", async ({
    page,
  }) => {
    await openCedar(page);
    await expect(page.locator("[data-horde='watch-sideways']")).toBeVisible();
    // Another scroll lock (a dialog) opens over it, saving what it found...
    await page.evaluate(() => {
      const w = window as unknown as { saved: string };
      w.saved = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    });
    // ...the phone turns upright, then the dialog closes and restores.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("[data-horde='watch-sideways']")).toHaveCount(0);
    await page.evaluate(() => {
      document.body.style.overflow = (
        window as unknown as { saved: string }
      ).saved;
    });
    expect(
      await page.evaluate(() => getComputedStyle(document.body).overflow)
    ).not.toBe("hidden");
  });
});
