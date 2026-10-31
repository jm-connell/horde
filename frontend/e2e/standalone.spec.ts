import { devices, type CDPSession, type Page } from "@playwright/test";
import { expect, test, videoCard } from "./fixtures";

// The installed iOS app: a phone with touch, launched from the home screen
// (iOS reports that as `navigator.standalone`).
test.use({
  viewport: { width: 390, height: 844 },
  userAgent: devices["iPhone 13"].userAgent,
  isMobile: true,
  hasTouch: true,
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "standalone", {
      get: () => true,
      configurable: true,
    });
  });
});

/** A one-finger drag through `points` as real touch events. */
async function drag(cdp: CDPSession, points: [number, number][]) {
  const [first, ...rest] = points;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: first[0], y: first[1] }],
  });
  for (const [x, y] of rest) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

const rightwards = (x0: number, x1: number, y: number): [number, number][] =>
  Array.from({ length: 8 }, (_, i) => [x0 + ((x1 - x0) * (i + 1)) / 8, y]);

/** Open `path` as the installed app would show it. Chromium cannot emulate
 *  `display-mode: standalone`, so this applies the part of the app's
 *  standalone CSS that matters here: without it, a horizontal drag is
 *  Chromium's own swipe-to-go-back, not the app's. */
async function launch(page: Page, path: string) {
  await page.goto(path);
  await page.addStyleTag({
    content: "html, body { overscroll-behavior: none; }",
  });
}

async function openFirstVideo(page: Page) {
  await launch(page, "/");
  await videoCard(page, "Aurora Drift").first().click();
  await expect(page).toHaveURL(/\/watch\//);
}

test("a swipe from the left edge goes back", async ({ page }) => {
  await openFirstVideo(page);
  const cdp = await page.context().newCDPSession(page);
  // Start below the player, on the page itself.
  await drag(cdp, [[4, 760], ...rightwards(4, 200, 760)]);
  await expect(page).toHaveURL(/\/$/);
});

test("a short or vertical edge swipe stays on the page", async ({ page }) => {
  await openFirstVideo(page);
  const cdp = await page.context().newCDPSession(page);
  await drag(cdp, [[4, 760], ...rightwards(4, 50, 760)]);
  await expect(page.locator("[data-horde='edge-swipe-back']")).toHaveCount(0);
  await drag(cdp, [
    [4, 760],
    [8, 700],
    [10, 600],
    [12, 500],
  ]);
  // A swipe that starts away from the edge is the page's, too.
  await drag(cdp, [[120, 760], ...rightwards(120, 380, 760)]);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/watch\//);
});

test("dragging the scrub bar from its left end seeks, not goes back", async ({
  page,
}) => {
  await openFirstVideo(page);
  const bar = page.getByRole("slider", { name: "Seek" }).locator("..");
  const box = await bar.boundingBox();
  // On a phone the bar starts inside the edge zone.
  expect(box!.x).toBeLessThan(24);
  const x = box!.x + 1;
  const y = box!.y + box!.height / 2;
  // Tap the picture until the controls are up and the bar is under the finger.
  await expect
    .poll(async () => {
      const onBar = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.tagName !== "VIDEO",
        [x, y]
      );
      if (!onBar) await page.touchscreen.tap(195, y - 60);
      return onBar;
    })
    .toBe(true);
  const cdp = await page.context().newCDPSession(page);
  await drag(cdp, [[x, y], ...rightwards(x, 200, y)]);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/watch\//);
});

test("a second finger cancels an edge swipe", async ({ page }) => {
  await openFirstVideo(page);
  const cdp = await page.context().newCDPSession(page);
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    touchPoints: { x: number; y: number; id: number }[]
  ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  await touch("touchStart", [{ x: 4, y: 760, id: 1 }]);
  for (const [x, y] of rightwards(4, 150, 760)) {
    await touch("touchMove", [{ x, y, id: 1 }]);
  }
  // A tap with another finger while the first is held past the threshold.
  await touch("touchStart", [
    { x: 150, y: 760, id: 1 },
    { x: 300, y: 400, id: 2 },
  ]);
  await touch("touchEnd", [{ x: 150, y: 760, id: 1 }]);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/watch\//);
  await touch("touchEnd", []);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/watch\//);
});

test("the first page of the app has nothing to swipe back to", async ({
  page,
}) => {
  await launch(page, "/history");
  const cdp = await page.context().newCDPSession(page);
  await drag(cdp, [[4, 600], ...rightwards(4, 200, 600)]);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/history$/);
});

test("a browser tab has no edge swipe", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "standalone", {
      get: () => false,
      configurable: true,
    });
  });
  await openFirstVideo(page);
  const cdp = await page.context().newCDPSession(page);
  await drag(cdp, [[4, 760], ...rightwards(4, 200, 760)]);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/watch\//);
  await expect(page.getByRole("navigation", { name: "Tabs" })).toHaveCount(0);
});

test("the installed app on a phone has a floating tab bar", async ({
  page,
}) => {
  await launch(page, "/");
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  // Home, Search, Download and Chat by default; only the current tab shows
  // its label, but every tab keeps it as its name (the Download badge adds a
  // count to its text).
  await expect(tabs.locator("a, button")).toHaveText([
    /Home/,
    /Search/,
    /Download/,
    /Chat/,
  ]);
  await expect(tabs.getByRole("link", { name: "Home" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await tabs.getByRole("link", { name: "Download" }).click();
  await expect(page).toHaveURL(/\/download$/);
  await expect(tabs.getByRole("link", { name: "Download" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(tabs.getByRole("link", { name: "Home" })).not.toHaveAttribute(
    "aria-current"
  );

  // The current tab again scrolls back to the top.
  await expect
    .poll(() =>
      page.evaluate(() => {
        window.scrollTo(0, 400); // again until the page has loaded its length
        return window.scrollY;
      })
    )
    .toBe(400);
  await tabs.getByRole("link", { name: "Download" }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  // The page ends above the bar: its last line is not hidden behind it.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const footer = await page.getByRole("link", { name: "Docs" }).boundingBox();
  const island = await tabs.locator(".ui-panel").boundingBox();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(island!.y);
  // A floating island: clear of the screen's sides and bottom.
  expect(island!.x).toBeGreaterThan(16);
  expect(island!.y + island!.height).toBeLessThan(844);
});

test("the Search tab opens the search box and Chat opens Ask about Horde", async ({
  page,
}) => {
  await launch(page, "/history");
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await tabs.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("searchbox", { name: "Search library" })
  ).toBeFocused();
  await page.getByRole("button", { name: "Close search" }).click();

  await tabs.getByRole("button", { name: "Chat" }).click();
  const panel = page.getByRole("dialog", { name: "Ask about Horde" });
  await expect(panel).toBeVisible();
  // Its question box takes focus, so the island steps aside for the keyboard
  // and the panel drops to the bottom of the screen.
  await expect(tabs).toHaveClass(/translate-y-full/);
  // Once the keyboard is closed the panel sits above the island, so Chat is
  // there to close it.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect(tabs).not.toHaveClass(/translate-y-full/);
  const panelBox = await panel.boundingBox();
  const island = await tabs.locator(".ui-panel").boundingBox();
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(island!.y);
  await tabs.getByRole("button", { name: "Chat" }).click();
  await expect(panel).toHaveCount(0);
});

test("a tap in Ask about Horde while typing lands where it was aimed", async ({
  page,
}) => {
  const answer = "Here is how.";
  await page.route(/\/api\/ask\/chat$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        { type: "token", text: answer },
        {
          type: "done",
          message: { id: null, role: "assistant", content: answer },
        },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join(""),
    })
  );
  await launch(page, "/");
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await tabs.getByRole("button", { name: "Chat" }).click();
  const panel = page.getByRole("dialog", { name: "Ask about Horde" });
  await panel.getByRole("textbox", { name: "Your question" }).fill("how?");
  // The tap takes focus from the question box. The island must not come
  // back (lifting the panel) under the finger before the tap is done.
  await panel.getByRole("button", { name: "Send" }).tap();
  await expect(panel.getByText(answer)).toBeVisible();
});

test("Settings chooses the tabs and their order", async ({ page }) => {
  await launch(page, "/settings?tab=appearance");
  const shown = page.getByRole("list", { name: "Tabs shown" });
  await shown.getByRole("button", { name: "Remove Chat" }).click();
  await page.getByRole("button", { name: "Add History" }).click();
  const earlier = shown.getByRole("button", { name: "Move History earlier" });
  await earlier.click();
  // Focus stays on the control that was used, in the tab's new row.
  await expect(earlier).toBeFocused();
  await expect(shown.getByRole("listitem")).toHaveText([
    "Home",
    "Search",
    "History",
    "Download",
  ]);
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await expect(tabs.locator("a, button")).toHaveText([
    /Home/,
    /Search/,
    /History/,
    /Download/,
  ]);
  // Wait for the reset to reach the server: the preference is synced.
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/settings") && r.request().method() === "PATCH"
  );
  await page.getByRole("button", { name: "Reset" }).click();
  await saved;
  await expect(tabs.locator("a, button")).toHaveText([
    /Home/,
    /Search/,
    /Download/,
    /Chat/,
  ]);
});

test("the tab bar steps aside for the keyboard", async ({ page }) => {
  await launch(page, "/");
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await expect(tabs).not.toHaveClass(/translate-y-full/);
  await page
    .locator("header")
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await expect(
    page.getByRole("searchbox", { name: "Search library" })
  ).toBeFocused();
  await expect(tabs).toHaveClass(/translate-y-full/);
  await page.getByRole("button", { name: "Close search" }).click();
  await expect(tabs).not.toHaveClass(/translate-y-full/);
});
