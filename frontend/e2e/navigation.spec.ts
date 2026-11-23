import {
  CSRF_HEADERS,
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

test("a modified click on Home leaves this tab's channel open", async ({
  page,
  context,
}) => {
  test.skip(!hasChannelRail(page), "the channel rail is desktop only");
  await page.goto("/");
  await openChannel(page, "Kiln");
  await expect(
    page.getByRole("heading", { name: /^Kiln/, level: 1 })
  ).toBeVisible();

  // Ctrl/Cmd-click opens a new tab; this tab must not be reset.
  const opened = context.waitForEvent("page");
  await page
    .getByRole("link", { name: "HORDE" })
    .click({ modifiers: ["ControlOrMeta"] });
  await (await opened).close();
  await expect(
    page.getByRole("heading", { name: /^Kiln/, level: 1 })
  ).toBeVisible();
});

test("Home clears the search and its results", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  const box = await openSearchBox(page);
  await box.fill("Aurora");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  const heading = page.getByRole("region", { name: /^Results/ });
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
  const recommended = page.getByRole("tab", {
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

test("the search box offers recent searches, newest first", async ({
  page,
}) => {
  await page.goto("/");
  await expect(videoCard(page, "Cedar Notes").first()).toBeVisible();
  const box = await openSearchBox(page);
  await box.fill("Cedar");
  await box.press("Enter");
  await box.fill("Aurora");
  await box.press("Enter");

  // An empty, focused box lists them under it.
  await box.fill("");
  const recent = page.getByRole("list", { name: "Recent searches" });
  await expect(
    recent.getByRole("button", { name: /^(Aurora|Cedar)$/ })
  ).toHaveText(["Aurora", "Cedar"]);
  // Typing hides them: the results are below.
  await box.fill("P");
  await expect(recent).toHaveCount(0);
  await box.fill("");

  // A recent search runs again when picked.
  await recent.getByRole("button", { name: "Cedar", exact: true }).click();
  await expect(box).toHaveValue("Cedar");
  await expect(videoCard(page, "Cedar Notes").first()).toBeVisible();
  await expect(recent).toHaveCount(0);

  // And can be taken off the list.
  await box.fill("");
  await box.focus();
  await recent
    .getByRole("button", { name: "Remove “Aurora” from recent searches" })
    .click();
  await expect(
    recent.getByRole("button", { name: /^(Aurora|Cedar)$/ })
  ).toHaveText(["Cedar"]);
});

test("opening a result keeps its search, and the list scrolls past four", async ({
  page,
}) => {
  const saved = await page.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: {
      ui: { search_history: ["one", "two", "three", "four", "five", "six"] },
    },
  });
  expect(saved.ok()).toBe(true);
  await page.goto("/");
  await expect(videoCard(page, "Cedar Notes").first()).toBeVisible();
  const box = await openSearchBox(page);
  await box.focus();
  const recent = page.getByRole("list", { name: "Recent searches" });
  await expect(recent.getByRole("listitem")).toHaveCount(6);
  // About four rows show; the rest scroll inside the box.
  const fit = await recent.evaluate((el) => {
    const row = el.querySelector("li")!.getBoundingClientRect().height;
    return {
      rows: el.clientHeight / row,
      scrolls: el.scrollHeight > el.clientHeight,
    };
  });
  expect(fit.rows).toBeGreaterThan(3.5);
  expect(fit.rows).toBeLessThanOrEqual(4.5);
  expect(fit.scrolls).toBe(true);

  // Typed without Enter, then a result opened: the search is kept.
  await box.fill("Paper");
  await videoCard(page, "Paper Kites").first().click();
  await expect(
    page.getByRole("heading", { name: "Paper Kites", level: 1 })
  ).toBeVisible();
  await page.goto("/");
  await expect(videoCard(page, "Cedar Notes").first()).toBeVisible();
  const again = await openSearchBox(page);
  await again.focus();
  await expect(recent.getByRole("listitem").first()).toHaveText("Paper");
});

test("the recent searches stay on a narrow phone's screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const saved = await page.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { ui: { search_history: ["cedar strip canoe build", "aurora"] } },
  });
  expect(saved.ok()).toBe(true);
  await page.goto("/");
  await expect(videoCard(page, "Cedar Notes").first()).toBeVisible();
  const box = await openSearchBox(page);
  await box.focus();
  const panel = page.locator("[data-horde='search-history']");
  await expect(panel).toBeVisible();
  const r = (await panel.boundingBox())!;
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.x + r.width).toBeLessThanOrEqual(360);
});

/**
 * Ancestors of `el` that are a backdrop root: a blurred menu inside one blurs
 * only that element, and the page shows through the menu sharp. These are
 * the triggers in Filter Effects 2 (backdrop-filter, filter, opacity, mask,
 * clip-path, mix-blend-mode, and will-change naming one of them).
 */
async function backdropRootAncestors(el: import("@playwright/test").Locator) {
  return el.evaluate((node) => {
    const found: string[] = [];
    for (let n = node.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (
        cs.backdropFilter !== "none" ||
        cs.filter !== "none" ||
        Number(cs.opacity) < 1 ||
        cs.maskImage !== "none" ||
        cs.clipPath !== "none" ||
        cs.mixBlendMode !== "normal" ||
        /filter|opacity|mask|clip-path|mix-blend-mode/.test(cs.willChange)
      ) {
        found.push(n.dataset.horde ?? n.tagName.toLowerCase());
      }
    }
    return found;
  });
}

test("menus from the top bar blur the page behind them, not just the bar", async ({
  page,
}) => {
  const saved = await page.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { ui: { search_history: ["aurora"] } },
  });
  expect(saved.ok()).toBe(true);
  await page.goto("/");
  await expect(videoCard(page, "Cedar Notes").first()).toBeVisible();

  const box = await openSearchBox(page);
  await box.focus();
  const recent = page.locator("[data-horde='search-history']");
  await expect(recent).toBeVisible();
  expect(
    await recent.evaluate((el) => getComputedStyle(el).backdropFilter)
  ).toContain("blur");
  expect(await backdropRootAncestors(recent)).toEqual([]);

  // A wide screen's account menu hangs from the bar too (a phone lists the
  // account in the ☰ menu, which is outside the bar).
  if (test.info().project.name === "app") {
    await page.locator("[data-horde='account-menu']").click();
    const menu = page.getByRole("menu", { name: "Account" });
    await expect(menu).toBeVisible();
    expect(await backdropRootAncestors(menu)).toEqual([]);
  }

  // The bar still blurs what scrolls under it, from a layer behind its
  // contents rather than the header itself.
  const bar = page.locator("header[data-horde='nav']");
  expect(
    await bar.evaluate((h) => getComputedStyle(h, "::before").backdropFilter)
  ).toContain("blur");
});

test("going Back to a video does not keep a half-typed search", async ({
  page,
}) => {
  await page.goto("/");
  await videoCard(page, "Aurora Drift").first().click();
  const heading = page.getByRole("heading", { name: "Aurora Drift", level: 1 });
  await expect(heading).toBeVisible();
  // Typing takes the search home; Back returns to the video with it typed.
  const box = await openSearchBox(page);
  await box.fill("aur");
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(heading).toBeVisible();
  // Give a (debounced) save the time it would take.
  await page.waitForTimeout(1500);
  const settings = await (await page.request.get("/api/settings")).json();
  expect(settings.ui?.search_history ?? []).not.toContain("aur");
});
