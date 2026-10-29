import type { Page } from "@playwright/test";
import { expect, feedCard, test } from "./fixtures";

/**
 * A YouTube channel's page while it is live, and its Live (streams) tab. The
 * suite is offline, so the channel's YouTube URL, its feeds and its live check
 * are answered in the browser; everything else is the seeded server.
 */
const CHANNEL_URL = "https://www.youtube.com/@kiln";

const upload = {
  id: "upload00001",
  url: "https://www.youtube.com/watch?v=upload00001",
  title: "Glazing basics",
  duration: 600,
  in_library: false,
};
const liveNow = {
  id: "livenow0001",
  url: "https://www.youtube.com/watch?v=livenow0001",
  title: "Firing the kiln live",
  in_library: false,
  live_status: "is_live",
};
const pastStream = {
  id: "paststream1",
  url: "https://www.youtube.com/watch?v=paststream1",
  title: "Overnight firing stream",
  duration: 3 * 3600 + 5 * 60,
  in_library: false,
  live_status: "was_live",
};

async function stubYoutubeChannel(page: Page) {
  // Give the seeded "Kiln" channel a YouTube URL.
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
  await page.route(/\/api\/channels\/feed\?/, async (route) => {
    const tab = new URL(route.request().url()).searchParams.get("tab");
    await route.fulfill({
      json: {
        channel: "Kiln",
        channel_url: CHANNEL_URL,
        entries: tab === "streams" ? [liveNow, pastStream] : [upload],
        has_more: false,
      },
    });
  });
  await page.route(/\/api\/live\/channel\?/, async (route) => {
    await route.fulfill({
      json: {
        live: {
          channel_url: "https://youtube.com/@kiln",
          channel_name: "Kiln",
          video_id: liveNow.id,
          title: liveNow.title,
          thumbnail_url: `https://i.ytimg.com/vi/${liveNow.id}/hqdefault_live.jpg`,
          watch_url: liveNow.url,
        },
      },
    });
  });
  await page.route(/\/api\/downloads\/preview\?/, (route) =>
    route.fulfill({ status: 502, json: { detail: "offline", code: "x" } })
  );
}

test("a live channel leads with its broadcast and lists its streams", async ({
  page,
}) => {
  await stubYoutubeChannel(page);
  await page.goto("/?channel=Kiln");

  const cards = page.locator("[data-horde='feed-card']");
  await expect(cards.first()).toContainText(liveNow.title);
  await expect(cards.first()).toContainText("LIVE");
  await expect(cards.first()).toContainText("Live now");
  await expect(
    cards.first().getByRole("button", { name: "Download" })
  ).toHaveCount(0);
  await expect(feedCard(page, upload.title)).toBeVisible();

  await page.getByRole("button", { name: "Live", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Live", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(cards.first()).toContainText(liveNow.title);
  await expect(feedCard(page, upload.title)).toHaveCount(0);
  const past = feedCard(page, pastStream.title);
  await expect(past).toContainText("3:05:00");

  // A stream over two hours asks before it is queued.
  await past.getByRole("button", { name: "Download" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Download a long livestream?",
  });
  await expect(dialog).toContainText("3h 5m long");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(pastStream.title)).toHaveCount(1);

  await past.getByRole("button", { name: "Download" }).click();
  await dialog.getByRole("button", { name: "Download anyway" }).click();
  await expect(dialog).toHaveCount(0);
  // Queued: the download panel lists it beside the card.
  await expect(page.getByText(pastStream.title)).toHaveCount(2);
});

test("a live card's 4:3 thumbnail is cropped to the same 16:9 as its neighbours", async ({
  page,
}) => {
  await stubYoutubeChannel(page);
  // YouTube's live thumbnail is 4:3 with black bars baked in; uploads are 16:9.
  await page.route("https://i.ytimg.com/**", (route) => {
    const live = route.request().url().includes("_live");
    const [w, h] = live ? [480, 360] : [320, 180];
    return route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#345"/></svg>`,
    });
  });
  await page.goto("/?channel=Kiln");

  const liveImage = page
    .locator("[data-horde='feed-card']")
    .first()
    .locator("img")
    .first();
  const uploadImage = feedCard(page, upload.title).locator("img").first();
  await expect(liveImage).toBeVisible();
  await expect(uploadImage).toBeVisible();
  const live = await liveImage.boundingBox();
  const other = await uploadImage.boundingBox();
  expect(live && other).toBeTruthy();
  expect(Math.abs(live!.height - other!.height)).toBeLessThan(2);
  expect(live!.width / live!.height).toBeCloseTo(16 / 9, 1);
});
