import type { Page } from "@playwright/test";
import { expectNoSeriousViolations } from "./axe";
import { contextAs, CSRF_HEADERS, expect, test } from "./fixtures";

/** A seeded video found on YouTube, from a channel the admin never watched. */
const FOUND = "Night sky timelapse from a lighthouse";

async function openRecommendedPlus(page: Page) {
  // The suite keeps YouTube search off, which hides Recommended+; report it on.
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
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Recommended+", exact: true }).click();
  await expect(page.getByText(FOUND)).toBeVisible();
}

// One server for the whole suite: put the admin's algorithm back after each test.
test.afterEach(async ({ page }) => {
  await page.request.put("/api/discover/tuning", {
    headers: CSRF_HEADERS,
    data: { active: "balanced" },
  });
  const saved = await page.request.get("/api/discover/algorithms");
  for (const a of (await saved.json()).items as {
    id: number;
    mine: boolean;
  }[]) {
    if (a.mine)
      await page.request.delete(`/api/discover/algorithms/${a.id}`, {
        headers: CSRF_HEADERS,
      });
  }
  const topics = await page.request.get("/api/discover/topics");
  for (const t of (await topics.json()).items as { id: number }[]) {
    await page.request.delete(`/api/discover/topics/${t.id}`, {
      headers: CSRF_HEADERS,
    });
  }
});

test("the algorithm panel re-ranks the feed and stays in step with Account", async ({
  page,
}) => {
  await openRecommendedPlus(page);
  const toggle = page.getByRole("button", { name: "Algorithm" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const panel = page.getByRole("dialog", { name: "Recommended+ algorithm" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Balanced", pressed: true })
  ).toBeVisible();
  await expectNoSeriousViolations(
    page,
    "algorithm panel",
    '[data-horde="side-panel"]'
  );

  // Each setting marks Balanced's value: a tick under a slider, "(default)"
  // in a list.
  await expect(
    panel.locator('[data-horde="slider-default"]').first()
  ).toBeAttached();
  await expect(
    panel.getByRole("button", { name: "Uploaded within: Any time (default)" })
  ).toBeVisible();
  // Shorts never reach Horde, so there is no filter for them.
  await expect(panel.getByText("Hide Shorts")).toHaveCount(0);

  // A preset is one click.
  await panel.getByRole("button", { name: "Explorer" }).click();
  await expect(
    panel.getByRole("button", { name: "Explorer", pressed: true })
  ).toBeVisible();

  // Turning new channels off takes the found videos out of the feed.
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/discover/tuning") && r.request().method() === "PUT"
  );
  await panel.getByLabel("New channels", { exact: true }).fill("0");
  await saved;
  await expect(
    panel.getByRole("button", { name: "Custom", pressed: true })
  ).toBeVisible();
  await expect(page.locator('[data-rec-key="discover001"]')).toHaveCount(0);

  // The Account page shows the same settings.
  await page.goto("/account");
  const section = page.getByRole("region", { name: "Recommended+ algorithm" });
  await expect(
    section.getByRole("button", { name: "Custom", pressed: true })
  ).toBeVisible();
  await expect(section.getByLabel("New channels", { exact: true })).toHaveValue(
    "0"
  );
  await section.getByRole("button", { name: "Reset" }).click();
  await expect(
    section.getByRole("button", { name: "Balanced", pressed: true })
  ).toBeVisible();

  // Back on the feed, the found videos are there again.
  await openRecommendedPlus(page);
  await expect(page.locator('[data-rec-key="discover001"]')).toBeVisible();
});

test("why this video shows what the score is made of", async ({ page }) => {
  await openRecommendedPlus(page);
  const card = page.locator('[data-rec-key="discover001"]');
  await card.hover();
  await card.getByRole("button", { name: "Tune recommendations" }).click();
  await page.getByRole("menuitem", { name: "Why this video?" }).click();
  const dialog = page.getByRole("dialog", { name: "Why this video?" });
  await expect(dialog.getByText("New channels")).toBeVisible();
  await expect(dialog.getByText("YouTube search: night sky")).toBeVisible();
  await expect(dialog.getByText("Total")).toBeVisible();
  await expectNoSeriousViolations(
    page,
    "why dialog",
    '[data-horde="why-dialog"]'
  );
  // It leads to the algorithm.
  await dialog.getByRole("button", { name: "Open algorithm" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Recommended+ algorithm" })
  ).toBeVisible();
});

test("with the chat open too, the panel shows tabs instead of two panels", async ({
  page,
}) => {
  await openRecommendedPlus(page);
  await page.getByRole("button", { name: "Algorithm" }).click();
  await page.getByRole("button", { name: "Ask about Horde" }).click();

  await expect(page.locator('[role="dialog"][aria-modal="false"]')).toHaveCount(
    1
  );
  const tabs = page.getByRole("tablist", { name: "Side panel" });
  const ask = tabs.getByRole("tab", { name: "Ask" });
  const algorithm = tabs.getByRole("tab", { name: "Algorithm" });
  await expect(ask).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("textbox", { name: "Your question" })
  ).toBeVisible();

  await algorithm.click();
  await expect(algorithm).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Explorer" })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Your question" })
  ).toBeHidden();
  // Arrow keys move between tabs.
  await algorithm.press("ArrowLeft");
  await expect(ask).toHaveAttribute("aria-selected", "true");

  // Closing the chat leaves the algorithm open, without tabs.
  await page.getByRole("button", { name: "Close Ask" }).click();
  await expect(tabs).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Recommended+ algorithm" })
  ).toBeVisible();

  // Elsewhere in the app it hides; back on the feed it is there again.
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Recommended+ algorithm" })
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Recommended+", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Recommended+ algorithm" })
  ).toBeVisible();
});

test("Escape closes an open list in the panel before the panel", async ({
  page,
}) => {
  await openRecommendedPlus(page);
  await page.getByRole("button", { name: "Algorithm" }).click();
  const panel = page.getByRole("dialog", { name: "Recommended+ algorithm" });
  // The taste window and lengths are advanced settings.
  await panel.getByRole("button", { name: "Advanced" }).click();
  const select = panel.getByRole("button", {
    name: "Recent taste is the last",
  });
  await select.click();
  await expect(select).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(select).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeVisible();
  // A longest length under the shortest is pointed out, not saved.
  await panel.getByLabel("Shortest (minutes)").fill("20");
  await panel.getByLabel("Longest (minutes)").fill("4");
  await expect(panel.getByRole("alert")).toContainText("not saved");
  await panel.getByLabel("Longest (minutes)").fill("45");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByLabel("Shortest (minutes)")).toHaveValue("20");
});

test("interests and blocked topics change the feed", async ({ page }) => {
  await openRecommendedPlus(page);
  await page.getByRole("button", { name: "Algorithm" }).click();
  const panel = page.getByRole("dialog", { name: "Recommended+ algorithm" });

  await panel.getByLabel("Add an interest").fill("night sky");
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(panel.locator('[data-topic="night sky"]')).toContainText(
    "Forever"
  );
  await expect(page.locator('[data-rec-key="discover001"]')).toHaveAttribute(
    "title",
    "For your interest: night sky"
  );

  // A block for two weeks.
  await panel.getByLabel("Block a topic").fill("aurora");
  await panel.getByRole("button", { name: "How long the block lasts" }).click();
  await page.getByRole("option", { name: "For 2 weeks" }).click();
  await panel.getByRole("button", { name: "Block", exact: true }).click();
  const row = panel.locator('[data-topic="aurora"]');
  await expect(row).toContainText("Until");
  await expect(page.getByText("Tracking the aurora by hand")).toHaveCount(0);
  await expect(row).toContainText("Hid 1 video");

  await row.getByRole("button", { name: "Delete aurora" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("Tracking the aurora by hand")).toBeVisible();
});

test("save an algorithm, share it, and save changes back to it", async ({
  page,
  browser,
  baseURL,
}) => {
  await openRecommendedPlus(page);
  await page.getByRole("button", { name: "Algorithm" }).click();
  const panel = page.getByRole("dialog", { name: "Recommended+ algorithm" });
  await panel.getByRole("button", { name: "Explorer" }).click();
  await expect(
    panel.getByRole("button", { name: "Explorer", pressed: true })
  ).toBeVisible();
  await panel.getByRole("button", { name: "Save as…" }).click();
  await panel.getByLabel("Name").fill("Weekend");
  await panel.getByLabel("Share with other accounts").check();
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Weekend", pressed: true })
  ).toBeVisible();
  await expect(
    panel.getByText("Yours, shared with other accounts.")
  ).toBeVisible();

  // Another account sees it, with its owner, and can pick it.
  const ctx = await contextAs(browser, baseURL, "member");
  const other = await ctx.newPage();
  await other.goto("/account");
  const section = other.getByRole("region", { name: "Recommended+ algorithm" });
  const chip = section.getByRole("button", { name: "Weekend · admin" });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(section.getByText("Shared by admin.")).toBeVisible();
  await other.request.put("/api/discover/tuning", {
    headers: CSRF_HEADERS,
    data: { active: "balanced" },
  });
  await ctx.close();

  // Moving a setting, then saving back to it.
  await panel.getByLabel("New channels", { exact: true }).fill("10");
  await expect(
    panel.getByRole("button", { name: "Custom", pressed: true })
  ).toBeVisible();
  await panel.getByRole("button", { name: "Save to “Weekend”" }).click();
  await expect(
    panel.getByRole("button", { name: "Weekend", pressed: true })
  ).toBeVisible();
  await expect(panel.getByLabel("New channels", { exact: true })).toHaveValue(
    "10"
  );
});
