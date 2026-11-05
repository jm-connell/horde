import type { Page } from "@playwright/test";
import { contextAs, expect, openSearchBox, test } from "./fixtures";

/** The seed's discovered videos (backend/app/e2e_seed.py E2E_DISCOVERED). */
const FOUND = "Night sky timelapse from a lighthouse";

/**
 * The browser suite keeps YouTube search off, which only changes the status
 * line; report it on (nothing here reaches YouTube: there is no gatherer offline).
 */
async function lookingOnYoutube(page: Page) {
  await page.route(/\/api\/discover\/status$/, async (route) => {
    let response;
    let status: Record<string, unknown>;
    try {
      response = await route.fetch();
      status = await response.json();
    } catch {
      return; // the page closed while a status read was in flight
    }
    await route.fulfill({ response, json: { ...status, enabled: true } });
  });
}

async function openRecommended(page: Page) {
  await lookingOnYoutube(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Recommended", exact: true }).click();
  await expect(page.getByText(FOUND)).toBeVisible();
}

test("Recommended mixes the library with videos found on YouTube", async ({
  page,
}) => {
  await openRecommended(page);
  // Found videos come from channels the admin never watched.
  const card = page.locator(`[data-rec-key="discover001"]`);
  // Why it is there: on hover, not as a line under every card.
  await expect(card).toHaveAttribute("title", "New channel for you");
  // Library videos are in the same feed.
  await expect(page.locator("[data-horde='video-card']").first()).toBeVisible();
  // Library and found cards in one row are one height.
  const boxes = await page.locator("[data-rec-key]").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), height: Math.round(r.height) };
    })
  );
  const firstRow = boxes.filter((b) => b.top === boxes[0].top);
  expect(firstRow.length).toBeGreaterThan(1);
  expect(new Set(firstRow.map((b) => b.height)).size).toBe(1);
  // The tab is remembered.
  await page.reload();
  await expect(page.getByText(FOUND)).toBeVisible();
});

test("source marks tell downloaded, your channels and new apart", async ({
  page,
}) => {
  await openRecommended(page);
  const legend = page.getByRole("list", { name: "What the outlines mean" });
  await expect(legend).toBeVisible();
  const found = page.locator(`[data-rec-key="discover001"]`);
  await expect(found.getByText("New to you.")).toBeAttached();

  // Always on: no toggle, and the legend sits beside the home tabs.
  await expect(page.getByRole("button", { name: "Sources" })).toHaveCount(0);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(legend).toHaveCount(0);
});

test("there is one Recommended tab, and an old Recommended+ choice lands on it", async ({
  page,
}) => {
  await lookingOnYoutube(page);
  await page.addInitScript(() =>
    localStorage.setItem("horde.home.tab", "discover")
  );
  await page.goto("/");
  await expect(page.getByText(FOUND)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Recommended", exact: true })
  ).toHaveAttribute("data-liquid-active", "true");
  await expect(page.getByRole("button", { name: "Recommended+" })).toHaveCount(
    0
  );
});

test("the home tab is remembered between visits, and a search does not change it", async ({
  page,
}) => {
  await lookingOnYoutube(page);
  await page.goto("/");
  const recommended = page.getByRole("button", {
    name: "Recommended",
    exact: true,
  });
  await recommended.click();
  await expect(page.getByText(FOUND)).toBeVisible();
  await page.reload();
  await expect(recommended).toHaveAttribute("data-liquid-active", "true");
  await expect(page.getByText(FOUND)).toBeVisible();

  // A search lists library results; clearing it goes back to Recommended.
  const box = await openSearchBox(page);
  await box.fill("Harbor");
  await expect(page.getByRole("region", { name: /^Results/ })).toBeVisible();
  await box.fill("");
  await expect(page.getByText(FOUND)).toBeVisible();
  await expect(recommended).toHaveAttribute("data-liquid-active", "true");
  await page.reload();
  await expect(recommended).toHaveAttribute("data-liquid-active", "true");

  // Picking a tab during a search leaves the search for that tab.
  await box.fill("Harbor");
  await expect(page.getByRole("region", { name: /^Results/ })).toBeVisible();
  await recommended.click();
  await expect(box).toHaveValue("");
  await expect(page.getByText(FOUND)).toBeVisible();

  // Library is remembered the same way.
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Library", exact: true })
  ).toHaveAttribute("data-liquid-active", "true");
});

test("the home tab follows the account to another browser", async ({
  page,
  browser,
  baseURL,
}) => {
  await lookingOnYoutube(page);
  await page.goto("/");
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes("/api/settings") &&
      r.request().method() === "PATCH" &&
      r.ok()
  );
  await page.getByRole("button", { name: "Recommended", exact: true }).click();
  await saved;

  const other = await contextAs(browser, baseURL, "admin");
  try {
    const elsewhere = await other.newPage();
    await elsewhere.goto("/");
    await expect(
      elsewhere.getByRole("button", { name: "Recommended", exact: true })
    ).toHaveAttribute("data-liquid-active", "true");
  } finally {
    await other.close();
  }
});

test("not interested removes a video, and undo brings it back", async ({
  page,
}) => {
  await openRecommended(page);
  const card = page.locator(`[data-rec-key="discover001"]`);
  await card.hover();
  await card.getByRole("button", { name: "Tune recommendations" }).click();
  await page.getByRole("menuitem", { name: "Not interested" }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(card).toBeVisible();

  // Saved for good: gone after a reload.
  await card.hover();
  await card.getByRole("button", { name: "Tune recommendations" }).click();
  await page.getByRole("menuitem", { name: "Not interested" }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Tracking the aurora by hand")).toBeVisible();
  await expect(page.locator(`[data-rec-key="discover001"]`)).toHaveCount(0);
});

test("blocking a channel removes all of its videos", async ({ page }) => {
  await openRecommended(page);
  const card = page.locator(`[data-rec-key="discover003"]`);
  await card.hover();
  await card.getByRole("button", { name: "Tune recommendations" }).click();
  await page
    .getByRole("menuitem", { name: "Don't recommend Tidepool Notes" })
    .click();
  await expect(page.getByText("Rock pools at low tide")).toHaveCount(0);
  await expect(page.getByText("What lives under a harbor pier")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(FOUND)).toBeVisible();
  await expect(page.getByText("Rock pools at low tide")).toHaveCount(0);

  // Account settings list it, and can take it back.
  await page.goto("/account");
  const hidden = page.getByRole("region", {
    name: "Hidden from recommendations",
  });
  await hidden
    .getByRole("button", { name: "Show Tidepool Notes again" })
    .click();
  await expect(hidden.getByText("Nothing hidden.")).toBeVisible();
  await openRecommended(page);
  await expect(page.getByText("Rock pools at low tide")).toBeVisible();
});

test("suggested channels can be followed or dismissed", async ({ page }) => {
  await openRecommended(page);
  const shelf = page.getByRole("region", { name: "Channels you might like" });
  await expect(shelf.getByText("Northern Skies")).toBeVisible();
  await expect(shelf.getByText("Tidepool Notes")).toBeVisible();
  // It follows whole rows of cards: none of the rows above it is cut short.
  const above = await page.evaluate(() => {
    const grid = document.querySelector("[data-rec-key]")?.parentElement;
    const shelf = grid?.querySelector('[aria-label="Channels you might like"]');
    if (!grid || !shelf) return null;
    const columns =
      getComputedStyle(grid).gridTemplateColumns.split(" ").length;
    const before = [...grid.children].indexOf(shelf);
    return { columns, before };
  });
  expect(above).not.toBeNull();
  expect(above!.before % above!.columns).toBe(0);

  await shelf
    .getByRole("button", { name: "Don't suggest Tidepool Notes" })
    .click();
  await expect(shelf.getByText("Tidepool Notes")).toHaveCount(0);

  await shelf.getByRole("button", { name: "Follow" }).click();
  await expect(page.getByText("Following Northern Skies")).toBeVisible();
  const follows = await page.request.get("/api/follows");
  const urls = (
    (await follows.json()) as { items: { channel_url: string }[] }
  ).items.map((f) => f.channel_url);
  expect(urls).toContain("https://youtube.com/@northernskies");
});

test("suggested channels show the channel's picture", async ({ page }) => {
  const avatar = "https://yt3.googleusercontent.com/skies=s176-c-k-no-rj";
  await page.route(/\/api\/channels\/avatar\?/, (route) => {
    const url = new URL(route.request().url()).searchParams.get("url");
    return route.fulfill({
      json: { url: url?.includes("northernskies") ? avatar : null },
    });
  });
  await page.route(avatar, (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64"
      ),
    })
  );
  await openRecommended(page);
  const shelf = page.getByRole("region", { name: "Channels you might like" });
  await expect(shelf.locator(`img[src="${avatar}"]`)).toBeVisible();
  // A channel without one shows its first letter instead.
  await expect(shelf.getByText("T", { exact: true })).toBeVisible();
});

test("Recommended is loaded ahead and opens at once", async ({ page }) => {
  await lookingOnYoutube(page);
  await page.addInitScript(() =>
    localStorage.setItem("horde.home.tab", "library")
  );
  const prefetched = page.waitForResponse(
    (r) =>
      r.url().includes("/api/discover/feed") &&
      r.url().includes("prefetch=true") &&
      r.ok()
  );
  await page.goto("/");
  await prefetched;
  // Opening the tab asks again (so the visit counts), but does not wait for it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/discover\/feed\?/, async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "Recommended", exact: true }).click();
  await expect(page.getByText(FOUND)).toBeVisible({ timeout: 1500 });
  release();
});

test("Recommended can be browsed by AI category", async ({ page }) => {
  // The browser suite has no AI: the server's answer gets a category, and a
  // category request keeps only the night sky video.
  const asked: (string | null)[] = [];
  await page.route(/\/api\/discover\/feed\?/, async (route) => {
    const url = new URL(route.request().url());
    const category = url.searchParams.get("category");
    asked.push(category);
    url.searchParams.delete("category");
    let response;
    let body: { items: { key: string }[]; categories?: string[] };
    try {
      response = await route.fetch({ url: url.toString() });
      body = await response.json();
    } catch {
      return; // the page moved on while this answer was in flight
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        categories: ["Night sky"],
        items: category
          ? body.items.filter((i) => i.key === "discover001")
          : body.items,
      },
    });
  });
  await openRecommended(page);
  const shelf = page.getByRole("region", { name: "Channels you might like" });
  await expect(shelf).toBeVisible();
  await page.getByRole("button", { name: "Night sky", exact: true }).click();
  await expect(page.locator("[data-rec-key]")).toHaveCount(1);
  await expect(page.getByText(FOUND)).toBeVisible();
  expect(asked).toContain("Night sky");
  // The channel shelf belongs to the whole feed.
  await expect(shelf).toHaveCount(0);
  await page.getByRole("button", { name: "For you", exact: true }).click();
  await expect(shelf).toBeVisible();
});
