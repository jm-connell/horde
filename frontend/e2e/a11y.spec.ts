import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * axe-core on every main page. Serious and critical violations fail the test;
 * minor/moderate ones are reported in the failure output only when something
 * else fails. Do not add exclusions without a comment saying why.
 */
async function expectNoSeriousViolations(
  page: Page,
  label: string,
  scope?: string
) {
  let axe = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
  ]);
  if (scope) axe = axe.include(scope);
  const results = await axe.analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical"
  );
  const summary = serious.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n` +
      v.nodes
        .slice(0, 5)
        .map(
          (n) =>
            `    ${n.target.join(" ")}  ${n.html.slice(0, 160)}\n      ${n.failureSummary ?? ""}`
        )
        .join("\n")
  );
  expect(summary, `${label}\n${summary.join("\n")}`).toEqual([]);
}

const settingsTabs = ["appearance", "library", "playback", "ai", "system"];

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
  const videos: { id: number; title: string }[] = await (
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

for (const [name, path] of [
  ["download", "/download"],
  ["playlists", "/playlists"],
  ["history", "/history"],
  ["import", "/import"],
] as const) {
  test(`${name} page has no serious accessibility violations`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(page.locator("main h1")).toBeVisible();
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

// The light theme's accent colour is a known low-contrast pairing for text, so
// this scan is scoped to the muted-text token, which is what this test guards.
test("light theme keeps muted text legible", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("horde.settings", JSON.stringify({ theme: "light" }));
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("[data-horde='video-card']").first()).toBeVisible();
  await expectNoSeriousViolations(page, "library (light theme)", ".text-muted");
});
