import { ensureNavVisible, expect, openNav, test } from "./fixtures";

test("nav reaches every primary page and legacy routes redirect", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  await expect(page.locator("[data-horde='nav']")).toBeVisible();
  await ensureNavVisible(page);
  await expect(page.getByRole("link", { name: /^Import\b/ })).toContainText(
    "1"
  );
  await expect(page.getByRole("link", { name: /^Download\b/ })).toContainText(
    "1"
  );

  await openNav(page, "Playlists");
  await expect(
    page.getByRole("heading", { name: "Playlists", level: 1 })
  ).toBeVisible();

  await openNav(page, "History");
  await expect(
    page.getByRole("heading", { name: "History", level: 1 })
  ).toBeVisible();

  await openNav(page, "Download");
  await expect(
    page.getByRole("heading", { name: "Download", level: 1 })
  ).toBeVisible();

  await openNav(page, "Import");
  await expect(
    page.getByRole("heading", { name: "Import", level: 1 })
  ).toBeVisible();

  await openNav(page, "Settings");
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 })
  ).toBeVisible();

  await page.getByRole("link", { name: "HORDE" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();

  await page.goto("/review");
  await expect(page).toHaveURL(/\/import$/);
  await expect(
    page.getByRole("heading", { name: "Import", level: 1 })
  ).toBeVisible();

  await page.goto("/playlists/4");
  await expect(page).toHaveURL(/\/playlists\?open=4$/);
  await expect(
    page.getByRole("heading", { name: "Playlists", level: 1 })
  ).toBeVisible();

  await page.goto("/setup");
  await expect(page).toHaveURL(/\/$/);
  await ensureNavVisible(page);
  await expect(
    page.getByRole("link", { name: "Home", exact: true })
  ).toBeVisible();
});

test("narrow screens open the nav from the menu button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Home", exact: true })
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle navigation menu" }).click();
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "History", level: 1 })
  ).toBeVisible();
});

test("an unknown URL shows the 404 page with a way home", async ({ page }) => {
  await page.goto("/no/such/page");
  await expect(page.locator("[data-horde='nav']")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Page not found", level: 1 })
  ).toBeVisible();
  await expect(page.getByText("/no/such/page")).toBeVisible();
  await page.getByRole("link", { name: "Go to library" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
});

// A real render-time failure without any test hook in production code: the
// History route is a lazy chunk, so blocking its download makes React.lazy
// throw while rendering, exactly as a deploy-while-open or flaky network would.
// The service worker would answer the chunk request itself, bypassing
// page.route, so it is blocked here to make the failure deterministic.
test.describe("route render failure", () => {
  test.use({ serviceWorkers: "block" });

  test("a route that fails to render shows the error page and recovers on navigation", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Home", level: 1 })
    ).toBeVisible();
    await page.route(/\/assets\/History-.*\.js/, (route) => route.abort());

    await openNav(page, "History");
    const alert = page.locator("[data-horde='error-boundary']");
    await expect(alert).toBeVisible();
    await expect(
      alert.getByRole("heading", { name: "This page could not be loaded" })
    ).toBeVisible();
    await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(alert.getByRole("link", { name: "Go home" })).toBeVisible();
    await alert.getByText("Error details").click();
    await expect(alert.locator("pre")).toContainText("dynamically imported");
    // The shell survives, so the user can simply navigate elsewhere.
    await openNav(page, "Playlists");
    await expect(alert).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Playlists", level: 1 })
    ).toBeVisible();
  });
});
