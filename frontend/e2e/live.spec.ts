import { expect, test } from "./fixtures";

/**
 * Followed channels and the sidebar's live list. The e2e server seeds one live
 * broadcast for `@hordelive` (there is no live poller offline); it shows up
 * once the user follows that channel.
 */
test("following a live channel lists it quietly in the sidebar", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator('[data-horde="live-now"]')).toHaveCount(0);

  await page.goto("/settings?tab=library");
  await page.getByRole("button", { name: /Followed channels/ }).click();
  await page.getByLabel("Channel URL or @handle").fill("@HordeLive");
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(page.getByText("https://youtube.com/@hordelive")).toBeVisible();

  await page.goto("/");
  const live = page.getByRole("region", { name: "Live now" });
  await expect(live).toBeVisible();
  const row = live.getByRole("button", { name: /Horde Live/ });
  await expect(row).toContainText("Late night speedruns");
  await expect(row).toContainText("Celeste");
  await expect(row).toContainText("1.2K watching");

  // The setting hides it again.
  await page.goto("/settings?tab=library");
  const toggle = page.getByRole("switch", { name: /Show live streams/ });
  await expect(toggle).toBeChecked();
  const saved = page.waitForResponse((response) => {
    const request = response.request();
    if (!response.url().includes("/api/settings")) return false;
    if (request.method() !== "PATCH" || !response.ok()) return false;
    const ui = (request.postDataJSON() as { ui?: Record<string, unknown> }).ui;
    return ui?.show_live_streams === false;
  });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await saved;
  await page.goto("/");
  await expect(page.locator("[data-horde='video-card']").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Live now" })).toHaveCount(0);
});

test("unfollowing removes the live entry", async ({ page }) => {
  await page.goto("/settings?tab=library");
  await page.getByRole("button", { name: /Followed channels/ }).click();
  await page.getByLabel("Channel URL or @handle").fill("@hordelive");
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await page.getByRole("button", { name: "Unfollow" }).click();
  await expect(page.getByText("https://youtube.com/@hordelive")).toHaveCount(0);
  await page.goto("/");
  await expect(page.locator("[data-horde='video-card']").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Live now" })).toHaveCount(0);
});
