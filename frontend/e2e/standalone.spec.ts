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
});
