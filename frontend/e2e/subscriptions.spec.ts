import { expect, openNav, test } from "./fixtures";

function card(page: import("@playwright/test").Page, name: string) {
  return page
    .getByRole("list", { name: "Subscriptions" })
    .getByRole("listitem")
    .filter({ hasText: name });
}

test("adding a channel by handle subscribes and can turn on auto-download", async ({
  page,
}) => {
  await page.goto("/");
  await openNav(page, "Subscriptions");
  await expect(
    page.getByRole("heading", { name: "Subscriptions", level: 1 })
  ).toBeVisible();

  await page
    .getByLabel("YouTube channel link or @handle")
    .fill("@e2enewchannel");
  await page.getByLabel("Download new uploads (1080p)").check();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(
    page.getByText(/new uploads will download by themselves/)
  ).toBeVisible();

  const row = card(page, "e2enewchannel");
  await expect(row.getByText("Auto-download on · 1080p")).toBeVisible();
});

test("Settings opens the channel's settings over the page", async ({
  page,
}) => {
  await page.goto("/subscriptions");
  await page
    .getByLabel("YouTube channel link or @handle")
    .fill("@e2esheetchannel");
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  const row = card(page, "e2esheetchannel");
  await row
    .getByRole("button", { name: /^Settings for .*e2esheetchannel$/ })
    .click();

  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/\/subscriptions$/);
  await expect(
    sheet.getByRole("heading", { name: "Automatic downloads" })
  ).toBeVisible();

  // Unsubscribing in the sheet takes the card off the page.
  await sheet
    .getByRole("switch", { name: "Subscribe to this channel" })
    .click();
  await sheet.getByRole("button", { name: "Close channel settings" }).click();
  await expect(sheet).toBeHidden();
  await expect(card(page, "e2esheetchannel")).toHaveCount(0);
});

test("a channel that downloads for everyone is listed apart", async ({
  page,
}) => {
  // Auto-download is server-wide: set it without subscribing.
  const saved = await page.request.put("/api/channels/autodownload", {
    headers: { "X-Horde-Request": "1" },
    data: {
      url: "https://www.youtube.com/@e2eeveryone",
      channel: "e2eeveryone",
      enabled: true,
      previous_mode: "none",
      quality_preset: "720p",
      include_completed_streams: false,
    },
  });
  expect(saved.ok()).toBeTruthy();
  await page.goto("/subscriptions");
  const others = page.getByRole("list", { name: "Downloading for everyone" });
  const row = others.getByRole("listitem").filter({ hasText: "e2eeveryone" });
  await expect(row.getByText("Auto-download on · 720p")).toBeVisible();
  await row.getByRole("button", { name: "Subscribe" }).click();
  await expect(card(page, "e2eeveryone")).toBeVisible();
  await expect(others).toHaveCount(0);
});

test("a big channel is not indexed for Ask without a confirm", async ({
  page,
}) => {
  const asked: { confirm_large: boolean }[] = [];
  await page.route(/\/api\/follows\/ask-index$/, (route) => {
    const body = route.request().postDataJSON() as { confirm_large: boolean };
    asked.push(body);
    return route.fulfill({
      json: {
        channel_url: "https://youtube.com/@e2ebigchannel",
        channel_name: "e2ebigchannel",
        video_count: 2400,
        indexed: body.confirm_large,
        already: false,
        large: !body.confirm_large,
      },
    });
  });
  await page.goto("/subscriptions");
  await page
    .getByLabel("YouTube channel link or @handle")
    .fill("@e2ebigchannel");
  await expect(page.getByLabel(/Index for Ask and search/)).toBeChecked();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  const warning = page
    .getByRole("status")
    .filter({ hasText: /has 2,400 videos, so it was not indexed/ });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Index anyway" }).click();
  await expect(page.getByText("Indexing e2ebigchannel for Ask")).toBeVisible();
  expect(asked.map((b) => b.confirm_large)).toEqual([false, true]);
});

test("unticking Ask indexing subscribes without indexing", async ({ page }) => {
  let asked = 0;
  await page.route(/\/api\/follows\/ask-index$/, (route) => {
    asked += 1;
    return route.abort();
  });
  await page.goto("/subscriptions");
  await page.getByLabel("YouTube channel link or @handle").fill("@e2enoindex");
  await page.getByLabel(/Index for Ask and search/).uncheck();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(card(page, "e2enoindex")).toBeVisible();
  expect(asked).toBe(0);
});
