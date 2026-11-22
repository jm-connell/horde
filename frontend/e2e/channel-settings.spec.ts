import type { Page } from "@playwright/test";
import { contextAs, CSRF_HEADERS, expect, test } from "./fixtures";

/**
 * The channel settings sheet: every per-channel option in one place. The
 * suite is offline, so the YouTube-only parts get a channel URL in the browser.
 */
const CHANNEL_URL = "https://www.youtube.com/@kiln";

async function giveKilnAYoutubeUrl(page: Page) {
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
        entries: [],
        has_more: false,
      },
    })
  );
  await page.route(/\/api\/live\/channel\?/, (route) =>
    route.fulfill({ json: { live: null } })
  );
}

test("channel settings open from the header and close with Escape", async ({
  page,
}) => {
  await giveKilnAYoutubeUrl(page);
  await page.goto("/?channel=Kiln");
  const gear = page.getByRole("button", { name: "Channel settings" });
  await gear.click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await expect(sheet).toBeVisible();
  for (const heading of [
    "Automatic downloads",
    "Clean up old videos",
    "Subscription",
    "Search",
    "Manage",
  ]) {
    await expect(sheet.getByRole("heading", { name: heading })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(gear).toBeFocused();
});

test("saving an auto-download change shows its chip", async ({ page }) => {
  await giveKilnAYoutubeUrl(page);
  // Saving for real would start a YouTube catalog sync; answer it here.
  let saved: Record<string, unknown> | null = null;
  await page.route(/\/api\/channels\/autodownload$/, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saved = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      json: {
        ...saved,
        configured: true,
        channel_url: CHANNEL_URL,
        channel_name: "Kiln",
        pending_estimate: 0,
        catalog_max_videos: 1000,
      },
    });
  });
  await page.goto("/?channel=Kiln");
  await page.getByRole("button", { name: "Channel settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await sheet
    .getByRole("switch", { name: "Download new uploads automatically" })
    .click();
  await sheet.getByRole("button", { name: "Auto-download resolution" }).click();
  await page.getByRole("option", { name: "720p" }).click();
  await sheet.getByRole("button", { name: "Save automatic downloads" }).click();
  await expect(page.getByText("Automatic downloads saved")).toBeVisible();
  expect(saved).toMatchObject({
    enabled: true,
    quality_preset: "720p",
    previous_mode: "none",
  });

  await page.keyboard.press("Escape");
  const chip = page.getByRole("button", { name: "Auto-download on · 720p" });
  await expect(chip).toBeVisible();
  // A chip opens the sheet at its section.
  await chip.click();
  await expect(
    sheet.getByRole("heading", { name: "Automatic downloads" })
  ).toBeFocused();
});

test("a retention rule previews, saves and shows in the header", async ({
  page,
}) => {
  await page.goto("/?channel=Northwind");
  await page.getByRole("button", { name: "Channel settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  const section = sheet.getByRole("region", { name: "Clean up old videos" });
  await expect(section).toContainText("Always kept");
  await expect(section).toContainText("It is in a playlist");

  await section.getByRole("checkbox", { name: "Keep only the newest" }).check();
  await section
    .getByRole("spinbutton", { name: /Keep only the newest/ })
    .fill("1");
  // Every seeded video was added today, so the exceptions keep them all.
  await expect(section.getByRole("status")).toHaveText(
    /Right now this would move nothing to the trash\. \d+ more are kept by the exceptions below\./
  );

  await section
    .getByRole("switch", { name: "Clean up this channel automatically" })
    .click();
  await section.getByRole("button", { name: "Save cleanup rule" }).click();
  await expect(page.getByText("Cleanup rule saved")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Keeps latest 1" })
  ).toBeVisible();

  // It stuck.
  await page.reload();
  await page.getByRole("button", { name: "Keeps latest 1" }).click();
  await expect(
    sheet.getByRole("switch", { name: "Clean up this channel automatically" })
  ).toBeChecked();
  await expect(
    sheet.getByRole("spinbutton", { name: /Keep only the newest/ })
  ).toHaveValue("1");
});

test("an account without the permissions sees the settings read-only", async ({
  browser,
  baseURL,
}) => {
  const ctx = await contextAs(browser, baseURL, "viewer");
  const page = await ctx.newPage();
  await page.goto("/?channel=Northwind");
  await page.getByRole("button", { name: "Channel settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  const retention = sheet.getByRole("region", { name: "Clean up old videos" });
  await expect(retention).toContainText(
    "Changing this needs the Delete videos permission."
  );
  await expect(
    retention.getByRole("switch", {
      name: "Clean up this channel automatically",
    })
  ).toBeDisabled();
  await expect(
    retention.getByRole("button", { name: "Save cleanup rule" })
  ).toHaveCount(0);
  await expect(sheet.getByLabel("Channel name")).toHaveCount(0);
  await ctx.close();
});

test("renaming into another channel says its cleanup rule was turned off", async ({
  page,
}) => {
  const saved = await page.request.put("/api/channels/retention", {
    headers: CSRF_HEADERS,
    data: { channel: "Kiln", enabled: true, keep_latest: 5 },
  });
  expect(saved.ok()).toBe(true);
  await page.goto("/?channel=Kiln");
  await page.getByRole("button", { name: "Keeps latest 5" }).click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await sheet.getByLabel("Channel name").fill("Northwind");
  await sheet.getByRole("button", { name: "Rename" }).click();
  await expect(
    page.getByText(
      "Retention rules were turned off because the channels were merged"
    )
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Northwind", level: 1 })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Keeps latest/ })).toHaveCount(
    0
  );
});

test("the header shows the channel's picture and its index beside Subscribe", async ({
  page,
}) => {
  await giveKilnAYoutubeUrl(page);
  const avatar = "https://yt3.googleusercontent.com/kiln=s176-c-k-no-rj";
  await page.route(/\/api\/channels\/avatar\?/, (route) =>
    route.fulfill({ json: { url: avatar } })
  );
  await page.route(avatar, (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64"
      ),
    })
  );
  await page.goto("/?channel=Kiln");

  // The sidebar's row for the channel carries the picture too.
  const inSidebar = '[data-horde="channel-list"] *';
  await expect(
    page.locator(`[data-horde="channel-list"] img[src="${avatar}"]`)
  ).toBeVisible();
  const picture = page.locator(`img[src="${avatar}"]:not(${inSidebar})`);
  await expect(picture).toBeVisible();
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await expect(page.getByText(/\d+ videos? downloaded/)).toBeVisible();

  // What Ask has indexed sits on the action row, left of Subscribe, not on a line of its own.
  const index = page.getByRole("button", { name: "Not indexed" });
  const follow = page.getByRole("button", { name: "Subscribe", exact: true });
  await expect(index).toBeVisible();
  await expect(page.getByRole("list", { name: "Channel status" })).toHaveCount(
    0
  );
  const [i, f] = await Promise.all([index.boundingBox(), follow.boundingBox()]);
  expect(i && f && i.x + i.width <= f.x).toBe(true);
  expect(
    i && f && Math.abs(i.y + i.height / 2 - (f.y + f.height / 2))
  ).toBeLessThan(4);
});

/** Ask's row for Kiln, as GET /api/ask/channels would list it. */
function askKiln(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    channel_url: "https://youtube.com/@kiln",
    channel_name: "Kiln",
    status: "ready",
    include_streams: false,
    max_videos: null,
    limit: 500,
    channel_total: 2310,
    videos: 500,
    fetched: 480,
    pending: 0,
    no_captions: 20,
    unavailable: 0,
    passages: 9000,
    last_listed_at: "2026-01-01T00:00:00Z",
    last_error: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

test("the header shows how much of the channel Ask has indexed", async ({
  page,
}) => {
  await giveKilnAYoutubeUrl(page);
  await page.route(/\/api\/ask\/channels$/, (route) =>
    route.fulfill({ json: { items: [askKiln()], available: true } })
  );
  await page.goto("/?channel=Kiln");

  // Against everything the channel uploaded, not only what the limit allows.
  const count = page.getByRole("button", { name: "500 of 2,310 indexed" });
  await expect(count).toBeVisible();
  await expect(page.getByRole("button", { name: "Not indexed" })).toHaveCount(
    0
  );
  // It opens the limit.
  await count.click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await expect(sheet.getByLabel("Newest videos to index")).toHaveValue("500");
  await expect(sheet.getByText(/The channel has 2,310 videos/)).toBeVisible();
});

test("the limit is set for one channel or for every channel", async ({
  page,
}) => {
  await giveKilnAYoutubeUrl(page);
  let row = askKiln();
  await page.route(/\/api\/ask\/channels$/, (route) =>
    route.fulfill({ json: { items: [row], available: true } })
  );
  const channelPatches: unknown[] = [];
  await page.route(/\/api\/ask\/channels\/7$/, (route) => {
    const body = route.request().postDataJSON() as {
      max_videos: number | null;
    };
    channelPatches.push(body);
    row = askKiln({
      max_videos: body.max_videos,
      limit: body.max_videos ?? row.limit,
    });
    return route.fulfill({ json: row });
  });
  const settingsPatches: unknown[] = [];
  await page.route(/\/api\/settings$/, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON() as { ask_max_videos: number };
    settingsPatches.push(body);
    row = askKiln({ limit: body.ask_max_videos });
    const response = await route.fetch();
    return route.fulfill({ response });
  });
  await page.goto("/?channel=Kiln&settings=ask");
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  const limit = sheet.getByLabel("Newest videos to index");
  const save = sheet.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();

  await limit.fill("1200");
  await save.click();
  await expect(
    sheet.getByText("This channel has its own limit.")
  ).toBeVisible();
  expect(channelPatches).toEqual([{ max_videos: 1200 }]);

  // Lowering it for every channel deletes what lies beyond, so it asks first.
  await sheet.getByLabel("Newest videos to index").fill("200");
  await sheet.getByLabel("Every channel").check();
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Lower the limit" }).click();
  await expect(
    sheet.getByText("This channel follows the limit for every channel.")
  ).toBeVisible();
  expect(settingsPatches).toEqual([{ ask_max_videos: 200 }]);
  expect(channelPatches).toEqual([{ max_videos: 1200 }, { max_videos: null }]);
  await expect(sheet.getByLabel("Newest videos to index")).toHaveValue("200");
});

test("raising its own limit to a lower one for every channel still asks first", async ({
  page,
}) => {
  // Kiln has its own 80; every other channel follows 500. Saving 300 for
  // every channel lowers theirs, so it must confirm, and nothing is saved
  // when that is cancelled.
  await giveKilnAYoutubeUrl(page);
  const row = askKiln({ max_videos: 80, limit: 80, videos: 80 });
  await page.route(/\/api\/ask\/channels$/, (route) =>
    route.fulfill({ json: { items: [row], available: true } })
  );
  const patches: unknown[] = [];
  await page.route(/\/api\/ask\/channels\/7$/, (route) => {
    patches.push(route.request().postDataJSON());
    return route.fulfill({ json: row });
  });
  await page.route(/\/api\/settings$/, async (route) => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().postDataJSON());
      return route.fulfill({ status: 500, json: { detail: "unexpected" } });
    }
    const response = await route.fetch();
    const json = await response.json();
    return route.fulfill({ response, json: { ...json, ask_max_videos: 500 } });
  });
  await page.goto("/?channel=Kiln&settings=ask");
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await sheet.getByLabel("Newest videos to index").fill("300");
  await sheet.getByLabel("Every channel").check();
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  const confirm = page.getByRole("dialog").filter({ hasText: "every channel" });
  await expect(
    confirm.getByRole("button", { name: "Lower the limit" })
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(patches).toEqual([]);
});
