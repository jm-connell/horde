import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** The seed's discovered videos (backend/app/e2e_seed.py E2E_DISCOVERED). */
const FOUND = "Night sky timelapse from a lighthouse";

/**
 * The browser suite keeps YouTube search off, which hides Recommended+; report
 * it on (nothing here reaches YouTube: there is no gatherer offline).
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

async function openRecommendedPlus(page: Page) {
  await lookingOnYoutube(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Recommended+", exact: true }).click();
  await expect(page.getByText(FOUND)).toBeVisible();
}

test("Recommended+ mixes the library with videos found on YouTube", async ({
  page,
}) => {
  await openRecommendedPlus(page);
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

test("source marks tell library, followed and other channels apart", async ({
  page,
}) => {
  await openRecommendedPlus(page);
  const legend = page.getByRole("list", { name: "What the outlines mean" });
  await expect(legend).toBeVisible();
  const found = page.locator(`[data-rec-key="discover001"]`);
  await expect(
    found.getByText("From a channel you don't follow.")
  ).toBeAttached();

  const sources = page.getByRole("button", { name: "Sources" });
  await expect(sources).toHaveAttribute("aria-pressed", "true");
  await sources.click();
  await expect(sources).toHaveAttribute("aria-pressed", "false");
  await expect(legend).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(FOUND)).toBeVisible();
  await expect(sources).toHaveAttribute("aria-pressed", "false");
});

test("Recommended+ is hidden while looking on YouTube is off", async ({
  page,
}) => {
  // The suite's settings keep YouTube search off.
  await page.addInitScript(() =>
    localStorage.setItem("horde.home.tab", "discover")
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Recommended", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Recommended+", exact: true })
  ).toHaveCount(0);
  // Someone who was on it lands on Recommended.
  await expect(
    page.getByRole("button", { name: "Include not downloaded" })
  ).toBeVisible();
});

test("not interested removes a video, and undo brings it back", async ({
  page,
}) => {
  await openRecommendedPlus(page);
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
  await openRecommendedPlus(page);
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
  await openRecommendedPlus(page);
  await expect(page.getByText("Rock pools at low tide")).toBeVisible();
});

test("suggested channels can be followed or dismissed", async ({ page }) => {
  await openRecommendedPlus(page);
  const shelf = page.getByRole("region", { name: "Channels you might like" });
  await expect(shelf.getByText("Northern Skies")).toBeVisible();
  await expect(shelf.getByText("Tidepool Notes")).toBeVisible();

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
