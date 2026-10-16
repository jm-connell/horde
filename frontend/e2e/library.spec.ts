import {
  expect,
  feedCard,
  hasChannelRail,
  openChannel,
  openSearchBox,
  test,
  videoCard,
} from "./fixtures";

test("home shows the library, continue watching, tags, and search", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Continue watching" })
  ).toBeVisible();
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await expect(videoCard(page, "Aurora Drift").first()).toContainText(
    "May 14, 2024"
  );
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
  if (hasChannelRail(page)) {
    await expect(page.getByRole("button", { name: /Northwind/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Kiln/ })).toBeVisible();
  }

  await page.getByRole("button", { name: "Tags" }).click();
  await page.getByRole("button", { name: /#ambient/ }).click();
  await expect(
    page.getByRole("heading", { name: "#ambient", level: 1 })
  ).toBeVisible();
  await expect(videoCard(page, "Aurora Drift")).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toHaveCount(0);

  if (hasChannelRail(page)) {
    await page.getByRole("button", { name: "All channels" }).click();
    await expect(
      page.getByRole("switch", { name: "Toggle YouTube search results" })
    ).toHaveAttribute("aria-checked", "false");
  }
  await (await openSearchBox(page)).fill("Harbor");
  const matches = page.locator("section").filter({
    has: page.getByRole("button", { name: /In your library/ }),
  });
  await expect(videoCard(matches, "Harbor Lights")).toBeVisible();
  await expect(videoCard(matches, "Aurora Drift")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Other videos in library/ })
  ).toBeVisible();
});

test("channel page filters the local feed and switches layout", async ({
  page,
}) => {
  await page.goto("/");
  await openChannel(page, "Northwind");
  await expect(
    page.getByRole("heading", { name: "Northwind", level: 1 })
  ).toBeVisible();
  await expect(page.getByText("Channel feed unavailable")).toHaveCount(0);
  await expect(feedCard(page, "Cedar Notes")).toBeVisible();
  await expect(page.getByPlaceholder("Search this channel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Feed sort" })).toBeVisible();

  await page.getByTitle("List view").click();
  await page.getByPlaceholder("Search this channel").fill("Harbor");
  await expect(feedCard(page, "Harbor Lights")).toBeVisible();
  await expect(feedCard(page, "Cedar Notes")).toHaveCount(0);

  await page.getByTitle("Grid view").click();
  await page.getByRole("button", { name: "Feed sort" }).click();
  await page.getByRole("option", { name: "Popular" }).click();
  await expect(
    page.getByText("Popularity is based on loaded videos")
  ).toBeVisible();
});

test("select mode selects a card without opening it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await videoCard(page, "Kiln fire").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("1 selected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .first()
    .click();
  await expect(page.getByText("1 selected")).toHaveCount(0);
  await videoCard(page, "Kiln fire").click();
  await expect(page).toHaveURL(/\/watch\//);
});

test("sort control changes the library order", async ({ page }) => {
  await page.goto("/");
  const grid = page.locator(".page-shell--animate");
  await page.getByRole("button", { name: "Sort library" }).click();
  await page.getByRole("option", { name: "Title" }).click();
  await expect(
    page.getByRole("button", { name: "Sort library" })
  ).toContainText("Title");
  await page.getByTitle("Toggle sort direction").click();
  await expect(grid.locator("[data-horde='video-card']").first()).toContainText(
    "Aurora Drift"
  );
  await expect(grid.locator("[data-horde='video-card']").last()).toContainText(
    "Paper Kites"
  );
});

test("continue watching dismisses from the row", async ({ page }) => {
  await page.goto("/");
  const row = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Continue watching" }),
  });
  const item = row.locator("div.group", { hasText: "Aurora Drift" });
  await item.hover();
  await item
    .getByRole("button", { name: "Remove from continue watching" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Continue watching" })
  ).toHaveCount(0);
  await expect(videoCard(page, "Aurora Drift")).toBeVisible();
});

test("a library the server hands over in pages still shows every video", async ({
  page,
}) => {
  // Re-cut the real answer into one-video pages: the grid has to follow the cursors.
  const cursors: (string | null)[] = [];
  await page.route(/\/api\/videos\?/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("continue_watching")) return route.fallback();
    const cursor = url.searchParams.get("cursor");
    cursors.push(cursor);
    url.searchParams.delete("cursor");
    url.searchParams.set("limit", "500");
    const real = await route.fetch({ url: url.toString() });
    const all: unknown[] = (await real.json()).items;
    const at = cursor ? Number(cursor) : 0;
    await route.fulfill({
      response: real,
      json: {
        items: all.slice(at, at + 1),
        next_cursor: at + 1 < all.length ? String(at + 1) : null,
      },
    });
  });
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
  await expect(videoCard(page, "Harbor Lights")).toBeVisible();
  expect(cursors.length).toBeGreaterThan(2);
});
