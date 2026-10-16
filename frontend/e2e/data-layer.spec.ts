import { ACCOUNTS } from "./accounts";
import { CSRF_HEADERS, expect, openNav, test, videoCard } from "./fixtures";

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

test("a session swapped in another tab leaves none of the old user's rows", async ({
  page,
}) => {
  await page.goto("/history");
  await expect(videoCard(page, "Aurora Drift")).toBeVisible();

  // Another tab signs in as someone else (the cookie jar is shared)...
  const login = await page.request.post("/api/auth/login", {
    headers: CSRF_HEADERS,
    data: ACCOUNTS.member,
  });
  expect(login.ok()).toBe(true);
  // ...and this tab notices when it is brought back to the front.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(page.getByText("No watch history yet.")).toBeVisible();
  await expect(videoCard(page, "Aurora Drift")).toHaveCount(0);
  await openNav(page, "Home");
  await expect(
    page.getByRole("heading", { name: "Continue watching" })
  ).toHaveCount(0);
});

test("the download list retries when its first read fails", async ({
  page,
}) => {
  let reads = 0;
  await page.route(/\/api\/downloads$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads += 1;
    if (reads === 1) return route.abort();
    return route.fallback();
  });
  await page.goto("/download");
  await expect(page.getByText("Queued night drive")).toBeVisible({
    timeout: 30_000,
  });
  expect(reads).toBeGreaterThan(1);
});

test("a failing refresh does not replace the video being watched", async ({
  page,
}) => {
  const list = await page.request.get("/api/videos?limit=500");
  const item = (await list.json()).items.find(
    (v: { title: string }) => v.title === "Aurora Drift"
  );
  let reads = 0;
  await page.route(new RegExp(`/api/videos/${item.id}$`), async (route) => {
    reads += 1;
    if (reads === 1) {
      // The server says it is still working, so the page keeps asking.
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({
        response,
        json: { ...body, processing_summary: true },
      });
    }
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ detail: "boom", code: "internal_error" }),
    });
  });
  await page.goto(`/watch/${item.id}`);
  await expect(
    page.getByRole("heading", { name: "Aurora Drift" }).first()
  ).toBeVisible();
  // The page's refresh fails with a 500; wait until the browser has it and the
  // UI has had a frame to react before checking the video is still shown.
  await page.waitForResponse(
    (r) =>
      new RegExp(`/api/videos/${item.id}$`).test(r.url()) && r.status() === 500,
    { timeout: 20_000 }
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await expect(page.getByText("Video not found")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Aurora Drift" }).first()
  ).toBeVisible();
});

test("an AI setting saved in Settings shows on the Watch page without another read", async ({
  page,
}) => {
  // A connected AI backend, with chat switched off to start from.
  await page.route(/\/api\/ai\/status$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, enabled: true, reachable: true },
    });
  });
  const off = await page.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { ai: { ai_chat: false } },
  });
  expect(off.ok()).toBe(true);

  await page.goto("/settings?tab=ai&pane=features");
  const chat = page
    .getByText("AI video chat", { exact: true })
    .locator("xpath=ancestor::*[.//button[@role='switch']][1]")
    .getByRole("switch");
  await expect(chat).toHaveAttribute("aria-checked", "false");
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes("/api/settings") &&
      r.request().method() === "PATCH" &&
      r.ok()
  );
  await chat.click();
  await saved;

  // The answer is in the cache: opening a video must show chat, with no read.
  let reads = 0;
  page.on("request", (r) => {
    if (r.method() === "GET" && /\/api\/settings$/.test(r.url())) reads += 1;
  });
  await openNav(page, "Home");
  await videoCard(page, "Aurora Drift").first().click();
  await expect(page.getByPlaceholder("Ask this video…")).toBeVisible();
  expect(reads).toBe(0);
});

test("the progress expiry saved in Settings is still there when Settings reopens", async ({
  page,
}) => {
  await page.goto("/");
  await openNav(page, "Settings");
  await page.getByRole("tab", { name: "Library" }).click();
  const field = () =>
    page
      .getByRole("heading", { name: "Progress expiry" })
      .locator("xpath=..")
      .getByRole("spinbutton");
  await field().fill("22");
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes("/api/settings") &&
      r.request().method() === "PATCH" &&
      r.ok()
  );
  await page
    .getByRole("heading", { name: "Progress expiry" })
    .locator("xpath=..")
    .getByRole("button", { name: "Save" })
    .click();
  await saved;

  // Leave and come back inside the cache's fresh window.
  await openNav(page, "Home");
  await openNav(page, "Settings");
  await page.getByRole("tab", { name: "Library" }).click();
  await expect(field()).toHaveValue("22");
});
