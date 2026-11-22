import {
  expect,
  feedCard,
  hasChannelRail,
  openChannel,
  openSearchBox,
  test,
  videoCard,
} from "./fixtures";

test("home shows the library, continue watching, tag pages, and search", async ({
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

  // No tags button on home (Recommended has categories); a video's tag links
  // open a tag page.
  await expect(page.getByRole("button", { name: "Tags" })).toHaveCount(0);
  await page.goto("/?tag=ambient");
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
  const matches = page.getByRole("region", { name: /^Results/ });
  await expect(videoCard(matches, "Harbor Lights")).toBeVisible();
  await expect(videoCard(matches, "Aurora Drift")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Rest of your library/ })
  ).toBeVisible();
});

test("a new search starts at the top of the page", async ({ page }) => {
  const { width } = page.viewportSize() ?? { width: 1280 };
  await page.setViewportSize({ width, height: 420 });
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  // To the bottom, then back up a little: the way back brings back a nav that
  // hid on the way down (each scroll its own frame, so neither is merged).
  await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(0)));
    window.scrollTo(0, document.body.scrollHeight);
    await frame();
    await frame();
    window.scrollBy(0, -40);
    await frame();
    await frame();
  });
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(100);
  const box = page
    .getByPlaceholder("Search", { exact: true })
    .locator("visible=true");
  if (!(await box.count())) {
    await page.getByRole("button", { name: "Search", exact: true }).click();
  }
  await box.fill("Harbor");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
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

  await page.getByRole("button", { name: "Clear tag #ambient" }).click();
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

test("a channel is renamed from its settings", async ({ page }) => {
  await page.goto("/?channel=Kiln");
  await page.getByRole("button", { name: "Channel settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await sheet.getByLabel("Channel name").fill("Kiln Works");
  await sheet.getByRole("button", { name: "Rename" }).click();
  await expect(sheet).toHaveCount(0);
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
    .getByRole("dialog", { name: "Move 2 videos to trash?" })
    .getByRole("button", { name: "Move to trash", exact: true })
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

  await page.getByRole("tab", { name: "Recommended", exact: true }).click();
  await expect(sort).toHaveCount(0);
  await expect(
    page.locator('button[title="Toggle sort direction"]')
  ).toHaveCount(0);

  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await expect(sort).toBeVisible();
});

test("the Recommended actions share the home tabs' row", async ({ page }) => {
  await page.goto("/");
  const tabs = page.getByRole("tablist", { name: "Home" });
  const recommended = tabs.getByRole("tab", { name: "Recommended" });
  await recommended.click();
  await expect(recommended).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: "Library" })).toHaveAttribute(
    "aria-selected",
    "false"
  );

  // One row on every width: the buttons sit level with the tabs.
  const algorithm = page.getByRole("button", { name: "Algorithm" });
  await expect(algorithm).toBeVisible();
  const tabsBox = (await tabs.boundingBox())!;
  const algoBox = (await algorithm.boundingBox())!;
  expect(
    Math.abs(algoBox.y + algoBox.height / 2 - (tabsBox.y + tabsBox.height / 2))
  ).toBeLessThan(8);

  // The seed does not look on YouTube: the note says so, links the admin to
  // the setting, and stays closed once closed.
  const note = page.locator('[data-horde="discover-off-notice"]');
  await expect(note).toContainText("Looking on YouTube is off");
  await expect(note.getByRole("link", { name: "Turn it on" })).toHaveAttribute(
    "href",
    "/settings?tab=library&find=discovery"
  );
  await note.getByRole("button", { name: "Hide this note" }).click();
  await expect(note).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Algorithm" })).toBeVisible();
  await expect(note).toHaveCount(0);
});

test("a Recommended card's menu adds its video to the queue", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Recommended" }).click();
  const card = page
    .locator("[data-rec-key]")
    .filter({ has: page.locator("[data-horde='video-card']") })
    .first();
  await card.getByRole("button", { name: "Tune recommendations" }).click();
  await page.getByRole("menuitem", { name: "Add to queue" }).click();
  await expect(page.getByText("Added to the queue")).toBeVisible();
  await expect(page.getByText(/^Up next \(1\)$/)).toBeVisible();
});

test("the Recommended tab works without AI", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Recommended", exact: true }).click();
  // Ranked from the watch history alone: the library's videos are listed.
  await expect(page.locator("[data-horde='video-card']").first()).toBeVisible();
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

test("on a phone every Continue watching card keeps its outline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.route(/\/api\/history\/continue-streams$/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "streamleft1",
            url: "https://www.youtube.com/watch?v=streamleft1",
            title: "Streamed halfway last night",
            channel: "Stream Channel",
            duration: 3600,
            position_sec: 1800,
          },
        ],
        next_cursor: null,
      },
    })
  );
  await page.goto("/");
  await page.getByRole("tab", { name: "Recommended", exact: true }).click();
  const row = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Continue watching" }),
  });
  const libraryCard = row.locator("[data-horde='video-card']").first();
  const streamCard = row
    .locator("[data-continue-stream='streamleft1'] .ui-card")
    .first();
  await expect(libraryCard).toBeVisible();
  await expect(streamCard).toBeVisible();
  const outline = (el: Element) => getComputedStyle(el).boxShadow;
  const libraryOutline = await libraryCard.evaluate(outline);
  expect(libraryOutline).not.toBe("none");
  // A streamed video's card is boxed like the library's, not a bare feed row.
  expect(await streamCard.evaluate(outline)).toBe(libraryOutline);
});

test("search keeps YouTube's places while it loads", async ({ page }) => {
  // Force YouTube search on and answer it only when the test says so.
  await page.route("**/api/settings", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, youtube_video_search: true },
    });
  });
  // Enough catalog results that YouTube's places fall between cards.
  await page.route("**/api/channels/catalog/search**", (route) =>
    route.fulfill({
      json: {
        channel: null,
        entries: Array.from({ length: 8 }, (_, i) => ({
          id: `harborstr0${i}`,
          url: `https://www.youtube.com/watch?v=harborstr0${i}`,
          title: `Harbor stream ${i}`,
          channel: "Coastal Walks",
          in_library: false,
        })),
        has_more: false,
      },
    })
  );
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/youtube/search**", async (route) => {
    await gate;
    await route.fulfill({ json: YOUTUBE_HARBOR });
  });
  await page.goto("/");
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
  await (await openSearchBox(page)).fill("Harbor");

  // Mixed results hold YouTube's places with loading cards.
  const results = page.getByRole("region", { name: /^Results/ });
  const items = results.locator('[data-horde="mixed-item"]');
  const placeholders = results.locator('[data-horde="search-placeholder"]');
  await expect(placeholders.first()).toContainText("Searching YouTube…");
  await expect(results).toHaveAttribute("aria-busy", "true");
  const keysNow = () =>
    items.evaluateAll((els) => els.map((el) => el.getAttribute("data-key")));
  const before = await keysNow();
  expect(before.filter((k) => k?.startsWith("slot-"))).toHaveLength(4);

  release();
  await expect(feedCard(results, "Harbor ferry ride")).toBeVisible();
  await expect(placeholders).toHaveCount(0);
  const after = await keysNow();
  // One YouTube result: it takes the first place, the places left empty take
  // the last card (or go, at the very end), and every other card stays put.
  expect(after[before.indexOf("slot-0")]).toBe("yt:ytharbor001");
  const cards = before.filter((k) => !k?.startsWith("slot-"));
  const lastCard = cards[cards.length - 1];
  before.forEach((key, i) => {
    if (key?.startsWith("slot-") || key === lastCard) return;
    expect(after[i]).toBe(key);
  });
  expect(after).toHaveLength(before.length - 3);
});

test("in sections, the YouTube heading says it is searching", async ({
  page,
}) => {
  await page.route("**/api/settings", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, youtube_video_search: true },
    });
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/youtube/search**", async (route) => {
    await gate;
    await route.fulfill({ json: YOUTUBE_HARBOR });
  });
  await page.goto("/");
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
  await (await openSearchBox(page)).fill("Harbor");
  await page
    .getByRole("group", { name: "Results layout" })
    .getByRole("button", { name: "Sections" })
    .click();
  const heading = page.getByRole("button", { name: /On YouTube/ });
  await expect(heading).toContainText("Searching…");
  const nav = page.getByRole("navigation", { name: "Search results" });
  await expect(
    nav.getByRole("link", { name: /In your library/ })
  ).toBeVisible();

  release();
  await expect(heading).toContainText("1");
  await expect(heading).not.toContainText("Searching…");
  await expect(feedCard(page, "Harbor ferry ride")).toBeVisible();
});

const YOUTUBE_HARBOR = {
  entries: [
    {
      id: "ytharbor001",
      url: "https://www.youtube.com/watch?v=ytharbor001",
      title: "Harbor ferry ride",
      channel: "Coastal Walks",
      in_library: false,
    },
  ],
  has_more: false,
  youtube_video_search_effective: true,
};

test.describe("on a touch phone", () => {
  test.use({
    viewport: { width: 412, height: 839 },
    isMobile: true,
    hasTouch: true,
  });

  test("a card's preview stops once its picture scrolls off the middle", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Library", exact: true }).click();
    const card = videoCard(page, "Paper Kites").first();
    await expect(card).toBeVisible();
    /** Scroll so the picture's top sits `offset` px from the screen's middle. */
    const placePicture = (offset: number) =>
      card.evaluate((el, at) => {
        const frame = el.querySelector("[data-preview-frame]")!;
        const top = frame.getBoundingClientRect().top;
        window.scrollBy(0, top - (window.innerHeight / 2 + at));
      }, offset);

    // The picture over the middle of the screen plays.
    const height = await card
      .locator("[data-preview-frame]")
      .evaluate((el) => el.getBoundingClientRect().height);
    await placePicture(-height / 2);
    await expect(card).toHaveAttribute("data-preview-active", "true");

    // Its title still covers the middle, but the picture has gone past it.
    await placePicture(-height - 20);
    await expect(card).not.toHaveAttribute("data-preview-active", "true");
    await expect(page.locator("[data-preview-active='true']")).toHaveCount(0);
  });
});
