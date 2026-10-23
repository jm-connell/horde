import type { APIRequestContext, Page } from "@playwright/test";
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

async function setMemberRole(
  admin: APIRequestContext,
  isAdmin: boolean
): Promise<void> {
  const users: { id: number; username: string }[] = await (
    await admin.get("/api/users")
  ).json();
  const id = users.find((u) => u.username === "member")!.id;
  const resp = await admin.patch(`/api/users/${id}`, {
    headers: CSRF_HEADERS,
    data: { is_admin: isAdmin },
  });
  expect(resp.ok()).toBeTruthy();
}

/** Open `tab` (and an AI `pane`) on both pages; their headings must match. */
async function expectSameView(
  first: Page,
  second: Page,
  tab: string,
  pane?: string
): Promise<void> {
  for (const p of [first, second]) {
    await p.getByRole("tab", { name: tab, exact: true }).click();
    if (pane) {
      await p.getByRole("button", { name: pane, exact: true }).first().click();
    }
  }
  await expect
    .poll(
      async () => {
        const [a, b] = await Promise.all([headings(first), headings(second)]);
        return a.length > 0 && JSON.stringify(a) === JSON.stringify(b);
      },
      `${tab}${pane ? ` / ${pane}` : ""} matches`
    )
    .toBe(true);
}

test("a second administrator sees every setting the first one does", async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  await setMemberRole(request, true);
  const ctx = await contextAs(browser, baseURL, "member");
  const second = await ctx.newPage();
  await page.goto("/settings?tab=appearance");
  await second.goto("/settings?tab=appearance");

  const tabsOf = (p: Page) =>
    p.getByRole("tablist", { name: "Settings sections" }).getByRole("tab");
  await expect(tabsOf(page)).toHaveText([
    "Appearance",
    "Library",
    "Playback",
    "AI",
    "System",
  ]);
  await expect(tabsOf(second)).toHaveText(await tabsOf(page).allTextContents());

  for (const tab of ["Appearance", "Library", "Playback", "System"]) {
    await expectSameView(page, second, tab);
  }
  for (const pane of ["Providers", "Features", "Jobs"]) {
    await expectSameView(page, second, "AI", pane);
  }

  await second.getByRole("tab", { name: "Library" }).click();
  await expect(
    second.getByRole("radiogroup", { name: "Playback compatibility" })
  ).toBeVisible();
  await expect(second.getByLabel("Progress expiry in days")).toBeVisible();
  // And the server lets them change server-wide settings.
  const saved = await ctx.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { ui: { download_video_codec: "sidecar" }, progress_expiry_days: 20 },
  });
  expect(saved.ok()).toBeTruthy();
  await ctx.close();
});

test("a promotion or demotion reaches an open page without a reload", async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  void page;
  const configured = await request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { ai: { base_url: "http://127.0.0.1:9" } },
  });
  expect(configured.ok()).toBeTruthy();

  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto("/settings?tab=library");
  await expect(
    member.getByRole("heading", { name: "Display", level: 2 })
  ).toBeVisible();
  const tabs = member.getByRole("tablist", { name: "Settings sections" });
  await expect(tabs.getByRole("tab")).toHaveCount(3);

  // Promoted: the page picks it up when it comes back to the front.
  await setMemberRole(request, true);
  await member.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange"))
  );
  await expect(tabs.getByRole("tab")).toHaveCount(5);
  await expect(
    member.getByRole("heading", { name: "Metadata and catalog" })
  ).toBeVisible();
  // The provider setup is the real one, not the member's trimmed copy.
  await tabs.getByRole("tab", { name: "AI" }).click();
  await member.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(member.getByLabel("Ollama base URL")).toHaveValue(
    "http://127.0.0.1:9"
  );

  // Demoted: the next refused request brings the member view back.
  await setMemberRole(request, false);
  await tabs.getByRole("tab", { name: "Library" }).click();
  await member.getByLabel("Progress expiry in days").fill("30");
  await member
    .getByRole("button", { name: "Save", exact: true })
    .first()
    .click();
  await expect(
    member.getByText("Administrator access required").first()
  ).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(member.getByLabel("Progress expiry in days")).toHaveCount(0);
  await ctx.close();
});

test("the administrator can cap the library size and sees how full it is", async ({
  page,
}) => {
  await page.goto("/settings?tab=system");
  const limit = page.getByLabel("Max disk usage");
  await expect(limit).toBeEnabled();
  await expect(limit).toHaveValue("");
  try {
    await limit.fill("5");
    await limit.blur();
    await expect(page.getByText("Disk usage limit saved")).toBeVisible();
    const bar = page.getByRole("progressbar", {
      name: "Library size against the limit",
    });
    await expect(bar).toBeVisible();
    await expect(page.getByText(/ of 5 GB/)).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Max disk usage")).toHaveValue("5");
  } finally {
    await page.request.patch("/api/settings", {
      headers: CSRF_HEADERS,
      data: { max_library_bytes: null },
    });
  }
  await page.reload();
  await expect(page.getByLabel("Max disk usage")).toHaveValue("");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

test("members cannot set the disk usage limit", async ({
  browser,
  baseURL,
}) => {
  const ctx = await contextAs(browser, baseURL, "member");
  const refused = await ctx.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { max_library_bytes: 5 * 1024 ** 3 },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe("admin_required");
  await ctx.close();
});
