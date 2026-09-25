import { expect, openNav, test } from "./fixtures";

test("nav reaches every primary page and legacy routes redirect", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.locator("[data-horde='nav']")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Import\b/ })).toContainText("1");
  await expect(page.getByRole("link", { name: /^Download\b/ })).toContainText("1");

  await openNav(page, "Playlists");
  await expect(page.getByRole("heading", { name: "Playlists", level: 1 })).toBeVisible();

  await openNav(page, "History");
  await expect(page.getByRole("heading", { name: "History", level: 1 })).toBeVisible();

  await openNav(page, "Download");
  await expect(page.getByRole("heading", { name: "Download", level: 1 })).toBeVisible();

  await openNav(page, "Import");
  await expect(page.getByRole("heading", { name: "Import", level: 1 })).toBeVisible();

  await openNav(page, "Settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "HORDE" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

  await page.goto("/review");
  await expect(page).toHaveURL(/\/import$/);
  await expect(page.getByRole("heading", { name: "Import", level: 1 })).toBeVisible();

  await page.goto("/playlists/4");
  await expect(page).toHaveURL(/\/playlists\?open=4$/);
  await expect(page.getByRole("heading", { name: "Playlists", level: 1 })).toBeVisible();

  await page.goto("/setup");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
});

test("narrow screens open the nav from the menu button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle navigation menu" }).click();
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page.getByRole("heading", { name: "History", level: 1 })).toBeVisible();
});
