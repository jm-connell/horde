import type { Page } from "@playwright/test";
import { contextAs, CSRF_HEADERS, expect, test } from "./fixtures";

test("the playback compatibility panel is for administrators only", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/settings?tab=library");
  await expect(
    page.getByRole("radiogroup", { name: "Playback compatibility" })
  ).toBeVisible();

  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto("/settings?tab=library");
  await expect(
    member.getByRole("heading", { name: "Display", level: 2 })
  ).toBeVisible();
  await expect(
    member.getByRole("radiogroup", { name: "Playback compatibility" })
  ).toHaveCount(0);
  // Searching for it does not reveal it either.
  await member.getByLabel("Search settings").fill("codec");
  await expect(
    member.getByRole("radiogroup", { name: "Playback compatibility" })
  ).toHaveCount(0);

  // The server refuses the change, and the library totals behind the panel.
  const refused = await ctx.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { ui: { download_video_codec: "sidecar" } },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe("admin_required");
  expect((await ctx.request.get("/api/compat/summary")).status()).toBe(403);
  await ctx.close();
});

/** The headings of the open settings tab, in order. */
async function headings(page: Page): Promise<string[]> {
  return page.locator("#settings-panel").getByRole("heading").allTextContents();
}

test("members see only their own preferences and what their permissions allow", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/settings?tab=library");
  await expect(
    page.getByRole("heading", { name: "Metadata and catalog" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Progress expiry" })
  ).toBeVisible();

  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto("/settings?tab=library");
  const tabs = member.getByRole("tablist", { name: "Settings sections" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "Appearance",
    "Library",
    "Playback",
  ]);
  await expect(
    member.getByRole("heading", { name: "Downloads", level: 2 })
  ).toBeVisible();
  expect(await headings(member)).toEqual([
    "Display",
    "Default video sort",
    "Channel list order (sidebar)",
    "Downloads",
  ]);
  await expect(member.getByLabel("Progress expiry in days")).toHaveCount(0);
  // A search for a server setting finds nothing to jump to.
  await member.getByLabel("Search settings").fill("catalog");
  await expect(tabs.getByRole("tab", { name: "Library" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(member.locator("#settings-panel h2")).toHaveCount(0);
  await member.getByLabel("Search settings").fill("");

  // Backgrounds and fonts are shared server files: members pick, admins manage.
  const picked = await ctx.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { ui: { background_effect: "custom-image" } },
  });
  expect(picked.ok()).toBeTruthy();
  await member.goto("/settings?tab=appearance");
  await expect(
    member.getByText("An administrator can upload them.")
  ).toBeVisible();
  await expect(member.getByText("Image or GIF / WebM")).toHaveCount(0);
  await expect(
    member.getByRole("button", { name: "Extract palette" })
  ).toHaveCount(0);
  await ctx.close();

  // Without the download permission the download preferences go too.
  const viewerCtx = await contextAs(browser, baseURL, "viewer");
  const viewer = await viewerCtx.newPage();
  await viewer.goto("/settings?tab=library");
  await expect(
    viewer.getByRole("heading", { name: "Display", level: 2 })
  ).toBeVisible();
  expect(await headings(viewer)).toEqual([
    "Display",
    "Default video sort",
    "Channel list order (sidebar)",
  ]);
  await viewerCtx.close();
});
