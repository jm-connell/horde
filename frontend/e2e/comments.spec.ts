import { expect, openSearchBox, test, videoCard } from "./fixtures";
import type { Page } from "@playwright/test";

/** The seeded id of the library video called `title`. */
async function videoId(page: Page, title: string): Promise<number> {
  const list = await page.request.get("/api/videos?limit=500");
  const item = (await list.json()).items.find(
    (v: { title: string }) => v.title === title
  );
  return item.id;
}

test("saved comments show under the video, creator's note first, replies on request", async ({
  page,
}) => {
  await page.goto(`/watch/${await videoId(page, "Cedar Notes")}`);
  const panel = page.getByRole("region", { name: /Comments/ });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading")).toHaveText("Comments2.4K");

  const threads = panel.locator(":scope > ol > li");
  await expect(threads).toHaveCount(5);
  const pinned = threads.first();
  await expect(pinned).toContainText("Pinned");
  await expect(pinned).toContainText("Thanks for watching!");
  // A timestamp in a comment seeks the player, like one in the description.
  await expect(pinned.getByRole("button", { name: "0:42" })).toBeVisible();

  const glue = threads.nth(1);
  await expect(glue).toContainText("120 likes");
  await expect(glue).toContainText("by the creator");
  await expect(glue).not.toContainText("Titebond III");
  await glue.getByRole("button", { name: "2 replies" }).click();
  await expect(
    glue.getByRole("button", { name: "Hide replies" })
  ).toHaveAttribute("aria-expanded", "true");
  await expect(glue).toContainText("Titebond III, clamped overnight.");
  await expect(glue).toContainText("Same here, works great.");

  // The saved comments come in steps; fewer than YouTube's first 100 means
  // there is nothing more to read from YouTube.
  await panel.getByRole("button", { name: "Show more comments" }).click();
  await expect(threads).toHaveCount(10);
  await expect(
    panel.getByRole("button", { name: "Show more comments" })
  ).toHaveCount(0);
});

test("a video without a YouTube id has no comments section", async ({
  page,
}) => {
  await page.goto(`/watch/${await videoId(page, "Aurora Drift")}`);
  await expect(
    page.getByRole("heading", { name: "Aurora Drift" })
  ).toBeVisible();
  await expect(page.locator("[data-horde='comments']")).toHaveCount(0);
});

test("library search finds a video through its saved comments", async ({
  page,
}) => {
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await (await openSearchBox(page)).fill("zeppelin");
  const card = videoCard(page, "Cedar Notes").first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Why this video matched" }).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "In a YouTube comment: “Thanks for watching! The zeppelin bit is at 0:42”"
  );
});
