import { expectNoSeriousViolations } from "./axe";
import { anonymousContext, expect, test } from "./fixtures";

const settingsTabs = [
  "appearance",
  "library",
  "playback",
  "ai",
  "system",
  "users",
];

test("library page has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  await expect(page.locator("[data-horde='video-card']").first()).toBeVisible();
  await expectNoSeriousViolations(page, "library");
});

test("watch page has no serious accessibility violations", async ({
  page,
  request,
}) => {
  const { items: videos }: { items: { id: number; title: string }[] } = await (
    await request.get("/api/videos")
  ).json();
  const id = videos.find((v) => v.title === "Aurora Drift")!.id;
  await page.goto(`/watch/${id}`);
  await expect(
    page.getByRole("heading", { name: "Aurora Drift", level: 1 })
  ).toBeVisible();
  await page.locator("video").first().hover();
  await expect(page.getByRole("slider", { name: "Seek" })).toBeAttached();
  await expectNoSeriousViolations(page, "watch");
});

test("watch page menus open without violations", async ({ page }) => {
  await page.goto("/");
  await page
    .locator("[data-horde='video-card']", { hasText: "Kiln fire" })
    .click();
  await page.getByTitle("More actions").click();
  await expect(page.getByRole("menu", { name: "Video actions" })).toBeVisible();
  await expectNoSeriousViolations(page, "video actions menu");
});

// `ready` is content that arrives after the heading; auditing before it has
// faded in measures contrast mid-animation.
for (const { name, path, ready } of [
  { name: "download", path: "/download", ready: "Queued night drive" },
  { name: "playlists", path: "/playlists", ready: "Evening set" },
  { name: "history", path: "/history", ready: "Aurora Drift" },
  { name: "import", path: "/import", ready: undefined },
]) {
  test(`${name} page has no serious accessibility violations`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(page.locator("main h1")).toBeVisible();
    if (ready) await expect(page.getByText(ready).first()).toBeVisible();
    await expectNoSeriousViolations(page, name);
  });
}

for (const tab of settingsTabs) {
  test(`settings ${tab} tab has no serious accessibility violations`, async ({
    page,
  }) => {
    await page.goto(`/settings?tab=${tab}`);
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 })
    ).toBeVisible();
    // Lazy tabs and their data load after the heading; the pollers on these
    // pages mean the network never goes idle, so wait for the spinners instead.
    await expect(page.locator("main [role='status']")).toHaveCount(0);
    await expectNoSeriousViolations(page, `settings/${tab}`);
  });
}

test("404 page has no serious accessibility violations", async ({ page }) => {
  await page.goto("/no/such/page");
  await expect(
    page.getByRole("heading", { name: "Page not found", level: 1 })
  ).toBeVisible();
  await expectNoSeriousViolations(page, "404");
});

for (const theme of ["light", "earthy", "frozen", "mocha", "nord", "sunset"]) {
  // Themes with the lowest-contrast surfaces: muted, gray-400 and accent text
  // must all stay AA across the whole library page.
  test(`${theme} theme library page has no serious accessibility violations`, async ({
    page,
  }) => {
    await page.addInitScript((t) => {
      localStorage.setItem("horde.settings", JSON.stringify({ theme: t }));
    }, theme);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(
      page.locator("[data-horde='video-card']").first()
    ).toBeVisible();
    await expectNoSeriousViolations(page, `library (${theme} theme)`);
  });
}

test("sign-in page has no serious accessibility violations", async ({
  page,
  browser,
  baseURL,
}) => {
  void page;
  const ctx = await anonymousContext(browser, baseURL);
  const visitor = await ctx.newPage();
  await visitor.goto("/login");
  await expect(
    visitor.getByRole("heading", { name: "Sign in to Horde" })
  ).toBeVisible();
  await expectNoSeriousViolations(visitor, "login");
  await ctx.close();
});
