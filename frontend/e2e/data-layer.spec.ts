import { expect, openNav, test, videoCard } from "./fixtures";

const LIST = /\/api\/videos\?/;

test("a page that fails part-way keeps the videos already loaded", async ({
  page,
}) => {
  // Pretend the library has a second page, then fail it.
  await page.route(LIST, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor")) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "boom", code: "internal_error" }),
      });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, next_cursor: "more" },
    });
  });
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await expect(
    page.getByText(/Some videos could not be loaded/).first()
  ).toBeVisible();
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
});

test("coming back to the library paints the cached list while it refetches", async ({
  page,
}) => {
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await openNav(page, "History");
  await expect(
    page.getByRole("heading", { name: "History", level: 1 })
  ).toBeVisible();

  // Hold the library requests open: the list must not blank or shrink.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let pending = 0;
  await page.route(LIST, async (route) => {
    pending += 1;
    await gate;
    await route.continue();
  });
  await page.goBack();
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await expect.poll(() => pending).toBeGreaterThan(0);
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
  release();
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
});
