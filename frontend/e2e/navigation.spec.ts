import {
  ensureNavVisible,
  expect,
  hasChannelRail,
  openChannel,
  openNav,
  openSearchBox,
  test,
  videoCard,
} from "./fixtures";

/** Report a ready AI backend, so the home page offers its Recommended tab. */
async function withReadyAi(page: import("@playwright/test").Page) {
  await page.route(/\/api\/ai\/status$/, async (route) => {
    let response;
    let status: Record<string, unknown>;
    try {
      response = await route.fetch();
      status = await response.json();
    } catch {
      return; // the page closed while a status poll was in flight
    }
    await route.fulfill({
      response,
      json: { ...status, enabled: true, ready: true, paused: false },
    });
  });
}

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

// The logo and Home mean "start over on the home page", not just "/": a
// channel, a tag or a search must not survive the click.
test("the logo leaves a channel page for the base home page", async ({
  page,
}) => {
  await page.goto("/?channel=Kiln");
  await expect(
    page.getByRole("heading", { name: /^Kiln/, level: 1 })
  ).toBeVisible();

  await page.getByRole("link", { name: "HORDE" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^Kiln/, level: 1 })
  ).toHaveCount(0);
});

test("Home leaves a channel opened from the rail", async ({ page }) => {
  test.skip(!hasChannelRail(page), "the channel rail is desktop only");
  await page.goto("/");
  await openChannel(page, "Kiln");
  await expect(
    page.getByRole("heading", { name: /^Kiln/, level: 1 })
  ).toBeVisible();
  // The rail opens a channel in page state, so the address still says home.
  await expect(page).toHaveURL(/\/$/);

  await openNav(page, "Home");
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^Kiln/, level: 1 })
  ).toHaveCount(0);
});

test("Home clears the search and its results", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  const box = await openSearchBox(page);
  await box.fill("Aurora");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  const heading = page.getByRole("button", { name: /In your library/ });
  await expect(heading).toBeVisible();

  await openNav(page, "Home");
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  await expect(heading).toHaveCount(0);
  await expect(await openSearchBox(page)).toHaveValue("");
});

test("Home keeps the Recommended tab", async ({ page }) => {
  await withReadyAi(page);
  await page.goto("/");
  const recommended = page.getByRole("button", {
    name: "Recommended",
    exact: true,
  });
  await recommended.click();
  await expect(recommended).toHaveAttribute("data-liquid-active", "true");

  await openChannel(page, "Kiln");
  await expect(
    page.getByRole("heading", { name: /^Kiln/, level: 1 })
  ).toBeVisible();

  await openNav(page, "Home");
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  await expect(recommended).toHaveAttribute("data-liquid-active", "true");
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

    let loads = 0;
    page.on("load", () => (loads += 1));
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
    // A failed chunk gets exactly one automatic hard reload; the second failure
    // shows the fallback instead of looping.
    expect(loads).toBe(1);
    // The shell survives, so the user can simply navigate elsewhere.
    await openNav(page, "Playlists");
    await expect(alert).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Playlists", level: 1 })
    ).toBeVisible();
  });
});
