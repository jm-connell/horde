import { contextAs, expect, test, videoCard } from "./fixtures";

/**
 * The response to the PATCH /api/settings that carries `field` set to `value`.
 *
 * Preference changes are sent debounced and the whole `ui` blob goes in every
 * request, so an earlier change (the progress-expiry save re-syncs its own
 * value 300 ms later) produces a PATCH of its own. Matching "any PATCH" can
 * resolve on that one, with the new preference still unsent; reloading then
 * loses it, exactly as a user who reloads within the debounce would.
 */
async function waitForSettingsPatch(
  page: import("@playwright/test").Page,
  field: string,
  value: string | boolean
) {
  return page.waitForResponse((response) => {
    const request = response.request();
    if (
      !response.url().includes("/api/settings") ||
      request.method() !== "PATCH" ||
      !response.ok()
    ) {
      return false;
    }
    const ui = (request.postDataJSON() as { ui?: Record<string, unknown> }).ui;
    return ui?.[field] === value;
  });
}

test("appearance changes theme and loading animation", async ({ page }) => {
  await page.goto("/settings?tab=appearance");
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 })
  ).toBeVisible();
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("option", { name: "OLED (true black)" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oled");
  // The phone status bar follows the theme's page background.
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "rgb(0 0 0)"
  );

  const helix = page
    .getByRole("group", { name: "Loading animation" })
    .getByRole("button", { name: "Helix" });
  await helix.click();
  await expect(helix).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("Helix — A double strand twisting in place")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Font" })).toBeVisible();
  await expect(page.getByLabel("Background animation").first()).toBeVisible();
});

test("a background shows only its own controls, and they stick", async ({
  page,
}) => {
  await page.goto("/settings?tab=appearance");
  const picker = page.getByRole("button", { name: /^Background animation:/ });
  // Nothing to tune until an animation is picked.
  await expect(page.getByRole("slider", { name: "Intensity" })).toHaveCount(0);

  await picker.click();
  // One list: None and Custom image, then every animation by name.
  const names = await page.getByRole("option").allTextContents();
  expect(names.slice(0, 2)).toEqual(["None", "Custom image"]);
  const animations = names.slice(2);
  expect(animations).toEqual([...animations].sort());
  expect(animations).toHaveLength(14);
  await page.getByRole("option", { name: "Rain" }).click();
  await expect(page.locator('canvas[data-horde="background"]')).toBeVisible();
  await expect(page.getByRole("slider", { name: "Intensity" })).toBeVisible();
  const angle = page.getByRole("slider", { name: "Angle" });
  const saved = waitForSettingsPatch(page, "background_effect", "rain");
  await angle.focus();
  await angle.press("ArrowRight");
  const tilted = await angle.inputValue();
  await saved;

  // Another animation has its own sliders, not Rain's.
  await picker.click();
  await page.getByRole("option", { name: "Mesh gradient" }).click();
  await expect(angle).toHaveCount(0);
  await expect(page.getByRole("button", { name: "RGB wave" })).toBeVisible();

  // Rain remembers its angle.
  await picker.click();
  await page.getByRole("option", { name: "Rain" }).click();
  await expect(angle).toHaveValue(tilted);
  await page.reload();
  await expect(angle).toHaveValue(tilted);
});

test("motion options apply and stick", async ({ page }) => {
  await page.goto("/settings?tab=appearance");
  const saved = waitForSettingsPatch(page, "nav_indicator", "focus");
  await page
    .locator('[data-setting="nav-indicator"]')
    .getByRole("button", { name: "Focus" })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-nav-indicator",
    "focus"
  );
  await saved;
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-nav-indicator",
    "focus"
  );
});

test("the section row jumps to a section", async ({ page }) => {
  await page.goto("/settings?tab=appearance");
  await page
    .getByRole("navigation", { name: "Appearance sections" })
    .getByRole("link", { name: "Panels" })
    .click();
  await expect(page.locator('[data-setting="panels"]')).toBeFocused();
  await expect(
    page.getByRole("slider", { name: "Panel blur" })
  ).toBeInViewport();
});

test("settings search finds a background by name", async ({ page }) => {
  await page.goto("/settings?tab=playback");
  await page.getByLabel("Search settings").fill("northern lights");
  await expect(
    page.getByRole("button", { name: /^Background animation:/ })
  ).toBeVisible();
});

test("the panel blur slider changes the blur on panels", async ({ page }) => {
  await page.goto("/settings?tab=appearance");
  const slider = page.getByRole("slider", { name: "Panel blur" });
  // The top bar blurs from a layer behind its contents (`::before`), so the
  // menus that hang below it blur the page; the slider must reach that layer.
  const header = page.locator("header.ui-panel").first();
  const backdrop = () =>
    header.evaluate((el) => getComputedStyle(el, "::before").backdropFilter);

  await slider.fill("1");
  await expect.poll(backdrop).toBe("blur(24px)");
  await slider.fill("0");
  await expect.poll(backdrop).toBe("blur(0px)");
});

test("settings search jumps to SponsorBlock", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Search settings").fill("sponsorblock");
  await expect(
    page.getByRole("heading", { name: "SponsorBlock" })
  ).toBeVisible();
  await expect(page.getByText("Enable SponsorBlock")).toBeVisible();
});

test("settings search finds an AI feature by its own label", async ({
  page,
}) => {
  await page.goto("/settings");
  const search = page.getByLabel("Search settings");
  for (const label of ["AI video chat", "AI video summaries"]) {
    await search.fill(label.toLowerCase());
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
});

test("library settings persist sort default, dates, and progress expiry", async ({
  page,
}) => {
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toContainText(
    "May 14, 2024"
  );

  await page.goto("/settings?tab=library");
  await expect(
    page.getByRole("heading", { name: "Progress expiry" })
  ).toBeVisible();
  await expect(page.getByText("Show dates on video cards")).toBeVisible();
  await expect(
    page.getByText("YouTube results in channel search")
  ).toBeVisible();

  const dates = page.getByRole("switch", { name: /Show dates on video cards/ });
  const saved = waitForSettingsPatch(page, "show_card_dates", false);
  await dates.click();
  await saved;

  const expiry = page
    .getByRole("heading", { name: "Progress expiry" })
    .locator("xpath=..");
  await expiry.getByRole("spinbutton").fill("21");
  const expirySaved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/settings") &&
      response.request().method() === "PATCH" &&
      response.ok()
  );
  await expiry.getByRole("button", { name: "Save" }).click();
  await expirySaved;

  const sort = page
    .getByRole("heading", { name: "Default video sort" })
    .locator("xpath=..");
  const sortSaved = waitForSettingsPatch(page, "default_library_sort", "title");
  await sort.getByRole("button", { name: "Title", exact: true }).click();
  await sortSaved;

  await page.evaluate(() => localStorage.removeItem("horde.library-sort"));
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).not.toContainText(
    "May 14, 2024"
  );
  await expect(
    page.getByRole("button", { name: "Sort library" })
  ).toContainText("Title");

  await page.goto("/settings?tab=library");
  await expect(expiry.getByRole("spinbutton")).toHaveValue("21");
});

test("playback settings hide the watch description", async ({ page }) => {
  await page.goto("/");
  await videoCard(page, "Aurora Drift").first().click();
  await expect(page).toHaveURL(/\/watch\//);
  const watchUrl = page.url();
  await expect(page.getByText("Aurora over the ridge line.")).toBeVisible();

  await page.goto("/settings?tab=playback");
  await expect(
    page.getByRole("button", { name: "Default stream quality" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Default stream quality" }).click();
  await page.getByRole("option", { name: "720p" }).click();
  await expect(
    page.getByRole("button", { name: "Default stream quality" })
  ).toContainText("720p");

  const toggle = page.getByRole("switch", { name: /Show description/ });
  const saved = waitForSettingsPatch(page, "show_description", false);
  await toggle.click();
  await saved;

  await page.goto(watchUrl);
  await expect(page.getByText("Aurora over the ridge line.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Cold open/ })).toBeVisible();
});

test("AI panes and system status render without calling providers", async ({
  page,
}) => {
  await page.goto("/settings?tab=ai");
  await expect(page.getByRole("button", { name: "Providers" })).toBeVisible();
  await expect(page.getByLabel("AI provider URL")).toBeVisible();
  await page.getByRole("button", { name: "Features" }).click();
  await expect(page.getByText("AI video summaries")).toBeVisible();
  await expect(page.getByText("AI video chapters")).toBeVisible();
  await page.getByRole("button", { name: "Jobs" }).click();
  await expect(page.getByRole("heading", { name: "Run now" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Automatic" })).toBeVisible();

  await page.goto("/settings?tab=system");
  await expect(page.getByText("yt-dlp", { exact: true })).toBeVisible();
  await expect(page.getByText("Pending import")).toBeVisible();
  await expect(page.getByText("Active downloads")).toBeVisible();
  await expect(page.getByText("Cookies", { exact: true })).toBeVisible();
  await expect(page.getByText("PO token provider")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset Horde…" }).click();
  const dialog = page.getByRole("dialog", { name: "Reset Horde?" });
  await expect(dialog).toBeVisible();
  // Both flavours need a typed phrase before the Reset button enables.
  const resetButton = dialog.getByRole("button", {
    name: "Reset",
    exact: true,
  });
  await expect(resetButton).toBeDisabled();
  await dialog.getByLabel("Type RESET to confirm").fill("RESET");
  await expect(resetButton).toBeEnabled();
  await dialog.getByRole("checkbox", { name: /Erase all media/ }).check();
  await expect(resetButton).toBeDisabled();
  await dialog.getByLabel("Type ERASE MEDIA to confirm").fill("RESET");
  await expect(resetButton).toBeDisabled();
  await dialog.getByLabel("Type ERASE MEDIA to confirm").fill("ERASE MEDIA");
  await expect(resetButton).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/tab=system/);
});

test("a change made just before a reload is still saved", async ({ page }) => {
  await page.goto("/settings?tab=library");
  const sort = page
    .getByRole("heading", { name: "Default video sort" })
    .locator("xpath=..");
  await expect(sort).toBeVisible();
  await sort.getByRole("button", { name: "Title", exact: true }).click();
  // No wait for the debounced save: leaving the page must send it.
  await page.reload();
  await page.evaluate(() => localStorage.removeItem("horde.library-sort"));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Sort library" })
  ).toContainText("Title");
  // The server has it too, not just this browser. The page shows the pending
  // change before its debounced re-send lands, so wait for the server.
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/settings")).json()).ui
          .default_library_sort
    )
    .toBe("title");
});

test("a change still in flight when the page reloads is not overwritten by the server's older copy", async ({
  page,
}) => {
  // Hold the save back so the next page's read of the settings reaches the
  // server first, the order the reload race produces on a slow connection.
  const sent: string[] = [];
  await page.route("**/api/settings", async (route) => {
    const method = route.request().method();
    sent.push(`${method} ${Date.now()}`);
    if (method === "PATCH") await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => undefined);
  });
  await page.goto("/settings?tab=library");
  const sort = page
    .getByRole("heading", { name: "Default video sort" })
    .locator("xpath=..");
  await expect(sort).toBeVisible();
  await sort.getByRole("button", { name: "Title", exact: true }).click();
  await page.reload();
  await page.evaluate(() => localStorage.removeItem("horde.library-sort"));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Sort library" })
  ).toContainText("Title");
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/settings");
      return (await res.json()).ui.default_library_sort;
    })
    .toBe("title");
});

test("Settings chooses the top bar's pages and order, for the account", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/settings?tab=appearance");
  const shown = page.getByRole("list", { name: "Pages in the top bar" });
  // Settings stays: nothing else in a wide bar leads to it.
  await expect(
    shown.getByRole("button", { name: "Remove Settings" })
  ).toBeDisabled();
  await shown.getByRole("button", { name: "Remove Import" }).click();
  await shown.getByRole("button", { name: "Remove Subscriptions" }).click();
  const saved = page.waitForResponse((response) => {
    const request = response.request();
    if (
      !response.url().includes("/api/settings") ||
      request.method() !== "PATCH" ||
      !response.ok()
    ) {
      return false;
    }
    const ui = (request.postDataJSON() as { ui?: Record<string, unknown> }).ui;
    return (ui?.nav_bar_items as string[] | undefined)?.[0] === "history";
  });
  const earlier = shown.getByRole("button", { name: "Move History earlier" });
  for (let i = 0; i < 2; i++) await earlier.click();
  // Focus follows the page to its new row; at the top, earlier is disabled.
  await expect(
    shown.getByRole("button", { name: "Move History later" })
  ).toBeFocused();
  await saved;
  await expect(shown.getByRole("listitem")).toHaveText([
    "History",
    "Home",
    "Playlists",
    "Offline",
    "Download",
    "Settings",
  ]);
  // Offline joins the bar only on a device with offline downloads.
  const bar = page.getByRole("banner");
  const barLinks = ["History", "Home", "Playlists", "Download", "Settings"];
  await expect(
    bar.getByRole("link", {
      name: /^(History|Home|Playlists|Download|Settings|Subscriptions|Import)\b/,
    })
  ).toHaveText(barLinks.map((name) => new RegExp(`^${name}`)));

  // A narrow window's menu still lists every page.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle navigation menu" }).click();
  const menu = page.locator("[data-horde='nav-menu']");
  await expect(menu.getByRole("link", { name: /^Import\b/ })).toBeVisible();
  await expect(
    menu.getByRole("link", { name: "Subscriptions", exact: true })
  ).toBeVisible();

  // The choice follows the account to another browser.
  const other = await contextAs(browser, baseURL, "admin");
  try {
    const elsewhere = await other.newPage();
    await elsewhere.goto("/");
    await expect(
      elsewhere.getByRole("banner").getByRole("link", {
        name: /^(History|Home|Playlists|Download|Settings|Subscriptions|Import)\b/,
      })
    ).toHaveText(barLinks.map((name) => new RegExp(`^${name}`)));
  } finally {
    await other.close();
  }
});

test("a short top bar still gives way to the menu on a landscape phone", async ({
  page,
}) => {
  const saved = await page.request.patch("/api/settings", {
    headers: { "X-Horde-Request": "1" },
    data: { ui: { nav_bar_items: ["home", "settings"] } },
  });
  expect(saved.ok()).toBe(true);
  await page.setViewportSize({ width: 915, height: 412 });
  await page.goto("/");
  // Two links would fit, but every page would not: the menu lists them all.
  const menu = page.getByRole("button", { name: "Toggle navigation menu" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(
    page
      .locator("[data-horde='nav-menu']")
      .getByRole("link", { name: "History" })
  ).toBeVisible();

  // A wide window shows just the chosen two.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(menu).toHaveCount(0);
  await expect(
    page.getByRole("banner").getByRole("link", { name: "History" })
  ).toHaveCount(0);
});

test("a section's Reset button keeps clear of the text under it", async ({
  page,
}) => {
  const saved = await page.request.patch("/api/settings", {
    headers: { "X-Horde-Request": "1" },
    data: { ui: { nav_bar_items: ["home", "settings"] } },
  });
  expect(saved.ok()).toBe(true);
  await page.goto("/settings?tab=appearance");
  const section = page.locator("[data-setting='nav-bar']");
  const reset = section.getByRole("button", { name: "Reset" });
  const description = section.getByText("On a wider screen, the top bar");
  await expect(reset).toBeVisible();
  const button = (await reset.boundingBox())!;
  const text = (await description.boundingBox())!;
  // The description used to start on the button's bottom edge.
  expect(text.y - (button.y + button.height)).toBeGreaterThanOrEqual(6);
});
