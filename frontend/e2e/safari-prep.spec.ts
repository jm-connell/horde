import { expect, test, videoCard } from "./fixtures";

// WebKit is detected from the user agent, so Chromium posing as an iPhone takes
// the Safari prep path (ask the server first, then play the original).
test.use({
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
});

test("an already prepared file plays without the Safari prep gate", async ({
  page,
}) => {
  let markAsked = () => {};
  const asked = new Promise<void>((resolve) => (markAsked = resolve));
  await page.route(/\/api\/videos\/\d+\/compat\/safari$/, async (route) => {
    markAsked();
    // A slow answer would have shown the gate for its whole round trip.
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({
      json: {
        kind: "safari",
        status: "ready",
        stage: null,
        progress: 100,
        error: null,
      },
    });
  });
  await page.goto("/");
  await videoCard(page, "Aurora Drift").first().click();
  await expect(page).toHaveURL(/\/watch\//);
  const gate = page.getByText("Preparing this video for Safari");
  await asked;
  // Mid round trip: the old code showed the gate here.
  await page.waitForTimeout(500);
  expect(await gate.count()).toBe(0);
  await expect
    .poll(() =>
      page
        .locator("video")
        .first()
        .evaluate((v: HTMLVideoElement) => v.currentSrc)
    )
    .toContain("/stream");
  expect(await gate.count()).toBe(0);
});

test("a file being rewritten shows the Safari prep gate", async ({ page }) => {
  await page.route(/\/api\/videos\/\d+\/compat\/safari$/, (route) =>
    route.fulfill({
      json: {
        kind: "safari",
        status: "running",
        stage: "encoding",
        progress: 40,
        error: null,
      },
    })
  );
  await page.goto("/");
  await videoCard(page, "Aurora Drift").first().click();
  await expect(
    page.getByText("Preparing this video for Safari… 40%")
  ).toBeVisible();
});
