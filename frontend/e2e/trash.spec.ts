import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test, videoCard } from "./fixtures";

async function videoId(request: APIRequestContext, title: string) {
  const { items } = await (await request.get("/api/videos")).json();
  return items.find((v: { title: string }) => v.title === title).id as number;
}

async function deleteFromWatchPage(page: Page, id: number) {
  await page.goto(`/watch/${id}`);
  await page.getByTitle("More actions").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to trash?" });
  await expect(dialog).toContainText("Deleted videos are kept for 7 days.");
  await dialog.getByRole("button", { name: "Move to trash" }).click();
  await expect(page).toHaveURL(/\/$/);
}

function toast(page: Page, text: string) {
  return page.locator("[data-horde='toast']", { hasText: text });
}

test("a deleted video waits in the trash and comes back", async ({
  page,
  request,
}) => {
  await deleteFromWatchPage(page, await videoId(request, "Harbor Lights"));
  // Undo in the toast puts it straight back.
  await toast(page, "Moved “Harbor Lights” to the trash")
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(toast(page, "Restored “Harbor Lights”")).toBeVisible();
  await expect(videoCard(page, "Harbor Lights").first()).toBeVisible();

  // Deleted again, it is listed in Settings with its size and time left.
  await deleteFromWatchPage(page, await videoId(request, "Harbor Lights"));
  await expect(videoCard(page, "Harbor Lights")).toHaveCount(0);
  await page.goto("/settings?tab=library");
  const summary = page.locator("[data-horde='trash-summary']");
  await expect(summary).toHaveText(
    /^1 video · \d+(\.\d)? (B|KB|MB) · deleted videos are kept for 7 days$/
  );

  const toggle = page.getByRole("button", { name: "Show videos in the trash" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const row = page
    .getByRole("list", { name: "Videos in the trash" })
    .getByRole("listitem")
    .filter({ hasText: "Harbor Lights" });
  await expect(row).toContainText("Northwind");
  await expect(row).toContainText("Deleted today by admin");
  await expect(row).toContainText("7 days left");

  await row.getByRole("button", { name: "Restore Harbor Lights" }).click();
  await expect(toast(page, "Restored “Harbor Lights”")).toBeVisible();
  await expect(page.getByText("The trash is empty.")).toBeVisible();
  await expect(summary).toHaveText(/^0 videos · /);

  await page.goto("/");
  await expect(videoCard(page, "Harbor Lights").first()).toBeVisible();
});

test("deleting the playing video stops it", async ({ page, request }) => {
  const id = await videoId(request, "Harbor Lights");
  await page.goto(`/watch/${id}`);
  const video = page.locator("video").first();
  await video.evaluate((v: HTMLVideoElement) => v.play());
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.paused))
    .toBe(false);

  await page.getByTitle("More actions").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: "Move to trash?" })
    .getByRole("button", { name: "Move to trash" })
    .click();
  await expect(page).toHaveURL(/\/$/);
  // Leaving the watch page would otherwise carry on in the mini player.
  await expect(page.locator(".player-mini")).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);

  await toast(page, "Moved “Harbor Lights” to the trash")
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(toast(page, "Restored “Harbor Lights”")).toBeVisible();
});

test("bulk-deleted videos are erased by emptying the trash", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const cards = page.locator("[data-horde='video-card'].video-card--feed");
  await expect(cards.first()).toBeVisible();
  const before = await cards.count();
  await cards.nth(0).click();
  await cards.nth(1).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move 2 videos to trash?" });
  await dialog.getByRole("button", { name: "Move to trash" }).click();
  await expect(toast(page, "Moved 2 videos to the trash")).toBeVisible();
  await expect(cards).toHaveCount(before - 2);

  await page.goto("/settings?tab=library");
  const summary = page.locator("[data-horde='trash-summary']");
  await expect(summary).toHaveText(/^2 videos · /);
  await page.getByRole("button", { name: "Empty trash" }).click();
  const confirm = page.getByRole("dialog", { name: "Empty the trash?" });
  await expect(confirm).toContainText(/Permanently delete 2 videos \(.+\)\?/);
  await confirm.getByRole("button", { name: "Empty trash" }).click();
  await expect(summary).toHaveText(/^0 videos · /);
  await expect(
    page.getByRole("button", { name: "Empty trash" })
  ).toBeDisabled();
  await expect(summary).toBeFocused();
});
