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
  let lastPageServed = false;
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
    const next = at + 1 < all.length ? String(at + 1) : null;
    await route.fulfill({
      response: real,
      json: { items: all.slice(at, at + 1), next_cursor: next },
    });
    if (next === null) lastPageServed = true;
  });
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
  await expect(videoCard(page, "Harbor Lights")).toBeVisible();
  // Let the walk reach the last page so no request is in flight at teardown.
  await expect.poll(() => lastPageServed).toBe(true);
  expect(cursors.length).toBeGreaterThan(2);
});

test("a default sort that arrives after the library mounted is applied", async ({
  page,
}) => {
  await page.goto("/");
  const sortButton = page.getByRole("button", { name: "Sort library" });
  await expect(sortButton).toContainText("Recently added");

  // The saved default lands after mount (settings hydrate on a fresh device,
  // or another tab saves one): same path as a storage event.
  await page.evaluate(() => {
    const key = "horde.settings";
    const current = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(
      key,
      JSON.stringify({ ...current, defaultLibrarySort: "title" })
    );
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });
  await expect(sortButton).toContainText("Title");

  // A sort picked in this session is not overridden by the default.
  await sortButton.click();
  await page.getByRole("option", { name: "Duration" }).click();
  await expect(sortButton).toContainText("Duration");
  await page.evaluate(() => {
    const key = "horde.settings";
    const current = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(
      key,
      JSON.stringify({ ...current, defaultLibrarySort: "file_size" })
    );
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });
  await expect(sortButton).toContainText("Duration");
});

test("a tag link opens the filtered library and its chip clears it", async ({
  page,
}) => {
  await page.goto("/?tag=ambient");
  await expect(
    page.getByRole("heading", { name: "#ambient", level: 1 })
  ).toBeVisible();
  await expect(videoCard(page, "Aurora Drift")).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toHaveCount(0);

  await page.getByRole("button", { name: "#ambient ✕" }).click();
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
});

test("a channel link opens that channel and drops the legacy tab parameter", async ({
  page,
}) => {
  await page.goto("/?channel=Kiln&tab=feed");
  await expect(
    page.getByRole("heading", { name: "Kiln", level: 1 })
  ).toBeVisible();
  await expect(feedCard(page, "Kiln fire")).toBeVisible();
  await expect(feedCard(page, "Aurora Drift")).toHaveCount(0);
  await expect(page).not.toHaveURL(/tab=feed/);
  await expect(page).toHaveURL(/channel=Kiln/);
});

test("a channel is renamed from its heading", async ({ page }) => {
  await page.goto("/?channel=Kiln");
  const heading = page.getByRole("heading", { name: /^Kiln/, level: 1 });
  await heading.hover();
  await page.getByTitle("Rename channel").click();
  const input = page.locator("input.text-2xl");
  await input.fill("Kiln Works");
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Kiln Works", level: 1 })
  ).toBeVisible();
  await expect(feedCard(page, "Kiln fire")).toBeVisible();
});

test("shift-click selects a range of cards and delete removes them", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  // The grid's cards; the continue-watching row above it has its own.
  const cards = page.locator("[data-horde='video-card'].video-card--feed");
  await expect(cards.first()).toBeVisible();
  const titles = await cards.allTextContents();
  expect(titles.length).toBeGreaterThan(3);

  await cards.nth(0).click();
  await cards.nth(2).click({ modifiers: ["Shift"] });
  await expect(page.getByText("3 selected")).toBeVisible();
  // A plain click on a selected card unselects just that card.
  await cards.nth(1).click();
  await expect(page.getByText("2 selected")).toBeVisible();

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByText("2 selected")).toHaveCount(0);
  await expect(cards).toHaveCount(titles.length - 2);
});

test("an in-app change of the ?tag= link replaces the open tag", async ({
  page,
}) => {
  await page.goto("/?tag=ambient");
  await expect(
    page.getByRole("heading", { name: "#ambient", level: 1 })
  ).toBeVisible();

  // A client-side navigation to another tag link (no page load).
  await page.evaluate(() => {
    window.history.pushState({}, "", "/?tag=craft");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    page.getByRole("heading", { name: "#craft", level: 1 })
  ).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
  await expect(videoCard(page, "Aurora Drift")).toHaveCount(0);

  // And back to the home page, which clears the tag.
  await page.evaluate(() => {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
});

test("the Recommended tab has no sort control", async ({ page }) => {
  // Recommended needs a ready AI backend; report one.
  await page.route(/\/api\/ai\/status$/, async (route) => {
    let response;
    let status: Record<string, unknown>;
    try {
      response = await route.fetch();
      status = await response.json();
    } catch {
      return; // the page closed while a status poll was in flight
    }
    await route.fulfill({
      response,
      json: { ...status, enabled: true, ready: true, paused: false },
    });
  });
  await page.goto("/");
  const sort = page.getByRole("button", { name: "Sort library" });
  await expect(sort).toBeVisible();

  await page.getByRole("button", { name: "Recommended", exact: true }).click();
  await expect(sort).toHaveCount(0);
  await expect(
    page.locator('button[title="Toggle sort direction"]')
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(sort).toBeVisible();
});

test("on a phone a feed card does not reserve a second title line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/?channel=Kiln");
  const card = feedCard(page, "Kiln fire");
  await expect(card).toBeVisible();
  const title = await card.getByText("Kiln fire").boundingBox();
  expect(title).not.toBeNull();
  // A one-line title is one line tall (20px), not a reserved two-line box.
  expect(title!.height).toBeLessThan(30);
});
