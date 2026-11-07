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
    .getByLabel("Find a YouTube channel: name, link or @handle")
    .fill("@e2enewchannel");
  await page.getByLabel("Download new uploads (1080p)").check();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(
    page.getByText(/new uploads will download by themselves/)
  ).toBeVisible();

  const row = card(page, "e2enewchannel");
  await expect(row.getByText("Auto 1080p", { exact: true })).toBeVisible();
});

test("Settings opens the channel's settings over the page", async ({
  page,
}) => {
  await page.goto("/subscriptions");
  await page
    .getByLabel("Find a YouTube channel: name, link or @handle")
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
  await expect(row.getByText("Auto 720p", { exact: true })).toBeVisible();
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
    .getByLabel("Find a YouTube channel: name, link or @handle")
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
  await page
    .getByLabel("Find a YouTube channel: name, link or @handle")
    .fill("@e2enoindex");
  await page.getByLabel(/Index for Ask and search/).uncheck();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(card(page, "e2enoindex")).toBeVisible();
  expect(asked).toBe(0);
});

test("a card shows the channel's subscriber count beside its name", async ({
  page,
}) => {
  await page.route(/\/api\/channels\/subscriptions$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      items: { channel_url: string; subscriber_count: number | null }[];
    };
    body.items = body.items.map((item) =>
      item.channel_url.endsWith("@e2esubcount")
        ? { ...item, subscriber_count: 19_500_000 }
        : item
    );
    return route.fulfill({ response, json: body });
  });
  await page.goto("/subscriptions");
  await page
    .getByLabel("Find a YouTube channel: name, link or @handle")
    .fill("@e2esubcount");
  await page.getByLabel(/Index for Ask and search/).uncheck();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  const row = card(page, "e2esubcount");
  await expect(row.getByText("19.5M subs")).toHaveAttribute(
    "title",
    "19,500,000 subscribers on YouTube"
  );
});

test("typing a name searches YouTube and shows the pick before subscribing", async ({
  page,
}) => {
  const searched: string[] = [];
  await page.route(/\/api\/channels\/search\?/, (route) => {
    searched.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    return route.fulfill({
      json: {
        results: [
          {
            name: "Glaze Lab",
            url: "https://www.youtube.com/@e2eglazelab",
            thumbnail_url: null,
            subscriber_count: 312_000,
          },
          {
            name: "Glaze Lab Shorts",
            url: "https://www.youtube.com/@e2eglazeshorts",
            thumbnail_url: null,
            subscriber_count: 900,
          },
        ],
      },
    });
  });
  await page.goto("/subscriptions");
  const subscribe = page
    .locator("form")
    .getByRole("button", { name: "Subscribe", exact: true });
  await page
    .getByLabel("Find a YouTube channel: name, link or @handle")
    .fill("glaze lab");
  // Nothing is picked yet, so there is nothing to subscribe to.
  await expect(subscribe).toBeDisabled();
  const found = page.getByRole("list", { name: "Channels found" });
  await expect(found.getByRole("button")).toHaveCount(2);
  await expect(found.getByText("312K subs")).toBeVisible();
  expect(searched).toEqual(["glaze lab"]);

  await found.getByRole("button", { name: /^Glaze Lab 312K subs$/ }).click();
  await expect(found).toHaveCount(0);
  const pick = page.getByRole("group", { name: "Found: Glaze Lab" });
  await expect(pick.getByText("312K subscribers")).toBeVisible();
  await expect(
    page.getByRole("switch", { name: /Index for Ask and search/ })
  ).toBeChecked();
  await expect(subscribe).toBeEnabled();
  await subscribe.click();
  await expect(card(page, "Glaze Lab")).toBeVisible();
  // The box is ready for the next one.
  await expect(
    page.getByLabel("Find a YouTube channel: name, link or @handle")
  ).toHaveValue("");
});

test("a link that is not a channel says so and cannot be subscribed", async ({
  page,
}) => {
  await page.route(/\/api\/follows\/preview\?/, (route) =>
    route.fulfill({
      status: 404,
      json: {
        detail: "No YouTube channel found there",
        code: "channel_not_found",
      },
    })
  );
  await page.goto("/subscriptions");
  await page
    .getByLabel("Find a YouTube channel: name, link or @handle")
    .fill("@e2edoesnotexist");
  await expect(page.getByText("No YouTube channel found there.")).toBeVisible();
  await expect(
    page.locator("form").getByRole("button", { name: "Subscribe", exact: true })
  ).toBeDisabled();
});
