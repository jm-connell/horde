import type { Page } from "@playwright/test";
import { expectNoSeriousViolations } from "./axe";
import { CSRF_HEADERS, expect, test } from "./fixtures";

/** Record a watch of a video played without downloading (cleaned up by the test). */
async function streamWatch(page: Page, id: string, title: string) {
  const resp = await page.request.post("/api/discover/history", {
    headers: CSRF_HEADERS,
    data: {
      url: `https://www.youtube.com/watch?v=${id}`,
      title,
      channel: "Stream Channel",
      position_sec: 120,
      duration_sec: 600,
    },
  });
  expect(resp.ok()).toBeTruthy();
}

const card = (page: Page, key: string) =>
  page.locator(`[data-history-key="${key}"]`);

test("streamed videos are in History and can be removed from it", async ({
  page,
}) => {
  await streamWatch(page, "histstream1", "A streamed documentary");
  await page.goto("/history");
  const entry = card(page, "histstream1");
  await expect(entry).toBeVisible();
  await expect(entry.getByText("· Streamed", { exact: true })).toBeVisible();
  // Library watches are still there, as library cards.
  await expect(
    page.locator("[data-horde='video-card']", { hasText: "Aurora Drift" })
  ).toBeVisible();

  await entry.hover();
  await entry
    .getByRole("button", { name: "History options for A streamed documentary" })
    .click();
  await page.getByRole("menuitem", { name: "Remove from history" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Remove “A streamed documentary” from your history?",
  });
  await expect(dialog).toContainText("cannot be undone");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(entry).toHaveCount(0);
  await page.reload();
  await expect(card(page, "histstream1")).toHaveCount(0);
});

test("select several watches to keep them out of recommendations or remove them", async ({
  page,
}) => {
  await streamWatch(page, "histpicked1", "First picked stream");
  await streamWatch(page, "histpicked2", "Second picked stream");
  await page.goto("/history");
  await page.getByRole("button", { name: "Select" }).click();
  const bar = page.locator('[data-horde="history-bulk-bar"]');
  await expect(bar).toBeVisible();
  await page
    .getByRole("button", { name: "Select First picked stream" })
    .click();
  await page
    .getByRole("button", { name: "Select Second picked stream" })
    .click();
  await expect(bar).toContainText("2 of");
  await expectNoSeriousViolations(page, "history select", "main");

  await bar
    .getByRole("button", { name: "Don't use for recommendations" })
    .click();
  // Kept, faded and marked.
  await expect(bar).toHaveCount(0);
  const first = card(page, "histpicked1");
  await expect(first.getByText("Not used for recommendations")).toBeVisible();
  await expect(first.locator(".opacity-50")).toHaveCount(1);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(first.getByText("Not used for recommendations")).toHaveCount(0);

  // A whole day at once, then remove.
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: "Select day" }).first().click();
  await expect(
    page.getByRole("button", { name: "Select First picked stream" })
  ).toHaveAttribute("aria-pressed", "true");
  // Only our two: unselect the rest of the day.
  await page.getByRole("button", { name: "Unselect day" }).first().click();
  await page
    .getByRole("button", { name: "Select First picked stream" })
    .click();
  await page
    .getByRole("button", { name: "Select Second picked stream" })
    .click();
  await bar.getByRole("button", { name: "Remove from history" }).click();
  await page
    .getByRole("dialog", { name: "Remove 2 videos from your history?" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(card(page, "histpicked1")).toHaveCount(0);
  await expect(card(page, "histpicked2")).toHaveCount(0);
});

test("videos watched on YouTube lately join Continue watching", async ({
  page,
}) => {
  await page.route(/\/api\/history\/continue-youtube$/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "ytrecent001",
            url: "https://www.youtube.com/watch?v=ytrecent001",
            title: "Watched on the phone yesterday",
            channel: "Phone Channel",
          },
        ],
        next_cursor: null,
      },
    })
  );
  await page.goto("/");
  const row = page.locator("[data-continue-youtube='ytrecent001']");
  await expect(row).toBeVisible();
  await expect(row.getByText("Watched on YouTube")).toBeVisible();
  await row.hover();
  await row
    .getByRole("button", { name: "Remove from continue watching" })
    .click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Watched on the phone yesterday")).toHaveCount(0);
});
