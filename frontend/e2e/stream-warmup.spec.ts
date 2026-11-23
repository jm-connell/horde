import type { Page, Route } from "@playwright/test";
import { expect, feedCard, test } from "./fixtures";

/**
 * Resting the mouse on a not-downloaded video's card loads its details and
 * has the server build its manifest, so the click plays at once. The suite is
 * offline: the channel feed and the stream endpoints are answered here.
 */
const CHANNEL_URL = "https://www.youtube.com/@kiln";

const upload = (id: string, title: string) => ({
  id,
  url: `https://www.youtube.com/watch?v=${id}`,
  title,
  duration: 600,
  in_library: false,
});
const A = upload("warmupvid0a", "Throwing a bowl");
const B = upload("warmupvid0b", "Trimming the foot");
const L = {
  ...upload("warmuplive1", "Firing tonight"),
  live_status: "is_live",
};

type Counts = Record<string, number>;

/** Stub the Kiln channel's YouTube feed and count stream requests by URL. */
async function stubChannel(
  page: Page,
  answerMeta?: (route: Route, url: string, seen: number) => Promise<void>
) {
  const meta: Counts = {};
  const manifest: Counts = {};
  await page.route(/\/api\/channels(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const rows = (await response.json()) as { channel: string }[];
    await route.fulfill({
      response,
      json: rows.map((row) =>
        row.channel === "Kiln" ? { ...row, channel_url: CHANNEL_URL } : row
      ),
    });
  });
  await page.route(/\/api\/channels\/feed\?/, (route) =>
    route.fulfill({
      json: {
        channel: "Kiln",
        channel_url: CHANNEL_URL,
        entries: [A, B, L],
        has_more: false,
      },
    })
  );
  await page.route(/\/api\/live\/channel\?/, (route) =>
    route.fulfill({ json: { live: null } })
  );
  await page.route(/\/api\/downloads\/preview\?/, (route) =>
    route.fulfill({ status: 502, json: { detail: "offline", code: "x" } })
  );
  await page.route(/\/api\/preview\/related\?/, (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } })
  );
  await page.route(/\/api\/preview\/(stream|subtitles|ai)\?/, (route) =>
    route.fulfill({ status: 404, json: { detail: "no media", code: "x" } })
  );
  // Otherwise the server asks YouTube for the made-up videos' comments.
  await page.route(/\/api\/comments\/youtube\//, (route) =>
    route.fulfill({
      json: { status: "disabled", total_count: null, items: [] },
    })
  );
  await page.route(/\/api\/preview\/manifest\?/, (route) => {
    const url = new URL(route.request().url()).searchParams.get("url") ?? "";
    manifest[url] = (manifest[url] ?? 0) + 1;
    return route.fulfill({
      status: 404,
      json: { detail: "no media", code: "x" },
    });
  });
  await page.route(/\/api\/preview\/meta\?/, async (route) => {
    const url = new URL(route.request().url()).searchParams.get("url") ?? "";
    meta[url] = (meta[url] ?? 0) + 1;
    if (answerMeta) return answerMeta(route, url, meta[url]);
    return route.fulfill({ json: metaFor(url) });
  });
  return { meta, manifest };
}

function metaFor(url: string) {
  const entry = [A, B, L].find((e) => e.url === url) ?? A;
  return {
    id: entry.id,
    title: entry.title,
    channel: "Kiln",
    channel_url: CHANNEL_URL,
    description: "",
    duration: 600,
    thumbnail_url: null,
    source_url: url,
    library_video_id: null,
    subtitles: [],
    available_presets: [],
    view_count: 10,
    is_live: url === L.url,
    was_live: false,
    resume_sec: 0,
  };
}

async function expectWatchPageOf(page: Page, title: string) {
  await expect(
    page.getByRole("heading", { name: title, level: 1 })
  ).toBeVisible();
}

test.skip(({ isMobile }) => isMobile, "hover is a pointer feature");

test("hovering a stream card loads its details and manifest before the click", async ({
  page,
}) => {
  const counts = await stubChannel(page);
  await page.goto("/?channel=Kiln");

  await feedCard(page, A.title).hover();
  await expect.poll(() => counts.meta[A.url] ?? 0).toBe(1);
  await expect.poll(() => counts.manifest[A.url] ?? 0).toBe(1);

  await feedCard(page, A.title).click();
  await expectWatchPageOf(page, A.title);
  expect(counts.meta[A.url]).toBe(1);
});

test("a click right after mouse-down shares the request", async ({ page }) => {
  const counts = await stubChannel(page, async (route, url) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ json: metaFor(url) });
  });
  await page.goto("/?channel=Kiln");

  await feedCard(page, B.title).click();
  await expectWatchPageOf(page, B.title);
  expect(counts.meta[B.url]).toBe(1);
});

test("a live card warms its details but not a manifest", async ({ page }) => {
  const counts = await stubChannel(page);
  await page.goto("/?channel=Kiln");

  await feedCard(page, L.title).hover();
  await expect.poll(() => counts.meta[L.url] ?? 0).toBe(1);
  await page.waitForTimeout(300);
  expect(counts.manifest[L.url] ?? 0).toBe(0);
});

test("sweeping across cards warms only the one the pointer rests on", async ({
  page,
}) => {
  const counts = await stubChannel(page);
  await page.goto("/?channel=Kiln");

  // Centres first: the moves between them must be quicker than the dwell.
  const centre = async (title: string) => {
    const box = await feedCard(page, title).boundingBox();
    if (!box) throw new Error(`no card for ${title}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const a = await centre(A.title);
  const b = await centre(B.title);
  await page.mouse.move(a.x, a.y);
  await page.mouse.move(b.x, b.y);

  await expect.poll(() => counts.meta[B.url] ?? 0).toBe(1);
  await page.waitForTimeout(300);
  expect(counts.meta[A.url] ?? 0).toBe(0);
});

test("keyboard focus on a card warms it", async ({ page }) => {
  const counts = await stubChannel(page);
  await page.goto("/?channel=Kiln");

  const link = feedCard(page, A.title)
    .locator("a[href^='/watch?url=']")
    .first();
  await expect(link).toBeVisible();
  // A key press first, so the focus that follows shows as keyboard focus.
  await page.keyboard.press("Tab");
  await link.focus();

  await expect.poll(() => counts.meta[A.url] ?? 0).toBe(1);
  await expect.poll(() => counts.manifest[A.url] ?? 0).toBe(1);
});

test("touch does not warm", async ({ page }) => {
  const counts = await stubChannel(page);
  await page.goto("/?channel=Kiln");

  const card = feedCard(page, A.title);
  await expect(card).toBeVisible();
  await card.dispatchEvent("pointerover", {
    pointerType: "touch",
    bubbles: true,
  });
  await card.dispatchEvent("pointerdown", {
    pointerType: "touch",
    bubbles: true,
  });
  await page.waitForTimeout(400);
  expect(counts.meta[A.url] ?? 0).toBe(0);
});

test("a failed warm-up does not stop the click", async ({ page }) => {
  const counts = await stubChannel(page, async (route, url, seen) => {
    if (url === A.url && seen === 1) {
      await route.fulfill({
        status: 502,
        json: { detail: "YouTube did not answer", code: "x" },
      });
      return;
    }
    await route.fulfill({ json: metaFor(url) });
  });
  await page.goto("/?channel=Kiln");

  await feedCard(page, A.title).hover();
  await expect.poll(() => counts.meta[A.url] ?? 0).toBe(1);

  await feedCard(page, A.title).click();
  await expectWatchPageOf(page, A.title);
  expect(counts.meta[A.url]).toBe(2);
});

test("coming back to a warmed video asks again", async ({ page }) => {
  const counts = await stubChannel(page);
  await page.goto("/?channel=Kiln");

  await feedCard(page, A.title).hover();
  await expect.poll(() => counts.meta[A.url] ?? 0).toBe(1);
  await feedCard(page, A.title).click();
  await expectWatchPageOf(page, A.title);

  await page.goBack();
  await feedCard(page, A.title).click();
  await expectWatchPageOf(page, A.title);
  expect(counts.meta[A.url]).toBe(2);
});
