import type { Page } from "@playwright/test";
import { expect, test, videoCard } from "./fixtures";

const insideDialog = (page: Page) =>
  page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return !!dialog && dialog.contains(document.activeElement);
  });

test("a confirm dialog traps Tab, closes on Escape and restores focus", async ({
  page,
}) => {
  await page.goto("/playlists");
  await page.getByRole("heading", { name: "Evening set", level: 3 }).click();
  const trigger = page.getByRole("button", { name: "Delete", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete this playlist?" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => insideDialog(page)).toBe(true);

  // Tab and Shift+Tab cycle inside the dialog and never reach the page behind.
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("Tab");
    expect(await insideDialog(page)).toBe(true);
  }
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await insideDialog(page)).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("menus support arrow keys and Escape returns focus to the trigger", async ({
  page,
}) => {
  await page.goto("/");
  await videoCard(page, "Kiln fire").click();
  const trigger = page.getByTitle("More actions");
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Video actions" });
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  const checkbox = menu.getByRole("menuitemcheckbox");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(items.first()).toBeFocused(); // "Edit details"

  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused(); // "Add note"
  await page.keyboard.press("ArrowDown");
  await expect(checkbox).toBeFocused(); // "Autoplay related"
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused(); // "Delete"
  await page.keyboard.press("ArrowDown"); // wraps
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("single-key shortcuts can be switched off; arrows still seek", async ({
  page,
}) => {
  const openWatch = async () => {
    await page.goto("/");
    await videoCard(page, "Aurora Drift").first().click();
    await expect(
      page.getByRole("heading", { name: "Aurora Drift", level: 1 })
    ).toBeVisible();
    await page
      .locator("video")
      .first()
      .evaluate(async (v: HTMLVideoElement) => {
        v.muted = true;
        if (v.readyState < 1) {
          await new Promise((r) =>
            v.addEventListener("loadedmetadata", r, { once: true })
          );
        }
        v.pause();
        v.currentTime = 1;
      });
    // Move focus off any control so keys reach the page-level handler.
    await page.locator("h1").click();
  };
  const paused = () =>
    page
      .locator("video")
      .first()
      .evaluate((v: HTMLVideoElement) => v.paused);
  const time = () =>
    page
      .locator("video")
      .first()
      .evaluate((v: HTMLVideoElement) => v.currentTime);

  // Default: "k" toggles playback.
  await openWatch();
  await page.keyboard.press("k");
  await expect.poll(paused).toBe(false);

  // Turn the shortcuts off in Settings > Playback.
  await page.goto("/settings?tab=playback");
  const toggle = page.getByRole("switch", {
    name: /Single-character hotkeys/,
  });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.waitForResponse(
    (r) =>
      r.url().includes("/api/settings") &&
      r.request().method() === "PATCH" &&
      r.ok()
  );

  await openWatch();
  expect(await paused()).toBe(true);
  await page.keyboard.press("k");
  await page.keyboard.press(" ");
  await page.waitForTimeout(300);
  expect(await paused()).toBe(true);

  const before = await time();
  await page.keyboard.press("ArrowRight");
  await expect.poll(time).toBeGreaterThanOrEqual(before + 4);
});

test("a rebound hotkey drives the player and focuses search", async ({
  page,
}) => {
  await page.goto("/settings?tab=playback");
  const playPause = page.getByRole("button", { name: /^Play \/ pause:/ });
  await expect(playPause).toHaveText("Space / K");
  await playPause.click();
  await expect(playPause).toHaveText("Press a key…");
  await page.keyboard.press("j");
  await expect(playPause).toHaveText("J");
  await page.waitForResponse(
    (r) =>
      r.url().includes("/api/settings") &&
      r.request().method() === "PATCH" &&
      r.ok()
  );

  // "/" focuses the nav search from any page.
  await page.locator("h1").click();
  await page.keyboard.press("/");
  await expect(
    page.getByRole("searchbox", { name: "Search library" })
  ).toBeFocused();

  await page.goto("/");
  await videoCard(page, "Aurora Drift").first().click();
  await expect(
    page.getByRole("heading", { name: "Aurora Drift", level: 1 })
  ).toBeVisible();
  const video = page.locator("video").first();
  await video.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true;
    if (v.readyState < 1) {
      await new Promise((r) =>
        v.addEventListener("loadedmetadata", r, { once: true })
      );
    }
    v.pause();
  });
  await page.locator("h1").click();
  const paused = () => video.evaluate((v: HTMLVideoElement) => v.paused);
  await page.keyboard.press("k");
  await page.waitForTimeout(300);
  expect(await paused()).toBe(true);
  await page.keyboard.press("j");
  await expect.poll(paused).toBe(false);
});
