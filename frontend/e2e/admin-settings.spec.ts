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

test("the administrator turns the media-server files on and removes them once off", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/settings?tab=library");
  const toggle = page.getByRole("switch", { name: "Write media-server files" });
  const remove = page.getByRole("button", { name: "Remove sidecar files" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(remove).toBeEnabled();
  try {
    await toggle.click();
    await expect(
      page.getByText(/Writing media-server files in the background/)
    ).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(remove).toBeDisabled();

    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(remove).toBeEnabled();
    await remove.click();
    const dialog = page.getByRole("dialog", {
      name: "Remove media-server files?",
    });
    await dialog.getByRole("button", { name: "Remove files" }).click();
    await expect(
      page.getByText(/Removing media-server files in the background/)
    ).toBeVisible();
  } finally {
    await page.request.patch("/api/settings", {
      headers: CSRF_HEADERS,
      data: { media_server_sidecars: false },
    });
  }

  // Members neither see the switch nor can they use the endpoints.
  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto("/settings?tab=library");
  await expect(
    member.getByRole("heading", { name: "Display", level: 2 })
  ).toBeVisible();
  await expect(
    member.getByRole("switch", { name: "Write media-server files" })
  ).toHaveCount(0);
  const refused = await ctx.request.post(
    "/api/settings/media-sidecars/remove",
    {
      headers: CSRF_HEADERS,
    }
  );
  expect(refused.status()).toBe(403);
  await ctx.close();
});

test("the administrator adds, tests, edits and removes a notification target", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/settings?tab=system");
  const section = page.locator("#settings-panel");
  await expect(
    section.getByRole("heading", { name: "Notifications" })
  ).toBeVisible();
  await section.getByRole("button", { name: "Add target" }).click();

  const form = section.getByRole("form", { name: "Add notification target" });
  // The events a new target starts with come from the server's list.
  await expect(form.getByLabel("Download failed")).toBeChecked();
  await expect(form.getByLabel("Download finished")).not.toBeChecked();
  await expect(form.getByText("Only automatic downloads")).toHaveCount(0);

  await form.getByLabel("Name").fill("My phone");
  await form.getByLabel("Server URL").fill("http://127.0.0.1:9");
  await form.getByLabel("Topic").fill("horde-e2e");
  await form.getByLabel("Access token (optional)").fill("tk_e2e_secret_1234");
  await form.getByLabel("Download finished").check();
  await expect(form.getByLabel("Only automatic downloads")).toBeChecked();

  // Nothing listens on that port, so the test fails in words, not a stack trace.
  await form.getByRole("button", { name: "Send test" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Not delivered: Could not connect to the server"
  );
  await form.getByRole("button", { name: "Add target" }).click();

  const row = section.getByRole("listitem").filter({ hasText: "My phone" });
  await expect(row).toContainText("Download failed, Download finished");
  await expect(
    row.getByRole("switch", { name: "Send notifications to My phone" })
  ).toBeChecked();

  // The token never comes back, only its tail.
  await page.reload();
  await row.getByRole("button", { name: "Edit My phone" }).click();
  const edit = section.getByRole("form", { name: "Edit My phone" });
  await expect(edit.getByLabel("Access token (optional)")).toHaveAttribute(
    "placeholder",
    "Saved (••••1234); type to replace"
  );
  await expect(page.locator("body")).not.toContainText("tk_e2e_secret_1234");
  await edit.getByLabel("Name").fill("Phone");
  await edit.getByRole("button", { name: "Save", exact: true }).click();

  const renamed = section.getByRole("listitem").filter({ hasText: "Phone" });
  await renamed.getByRole("button", { name: "Send test to Phone" }).click();
  await expect(renamed.getByRole("alert")).toContainText("Not delivered");
  await renamed
    .getByRole("switch", { name: "Send notifications to Phone" })
    .click();
  await expect(
    renamed.getByRole("switch", { name: "Send notifications to Phone" })
  ).not.toBeChecked();

  // Searching the settings finds the section from another tab.
  await page.getByRole("tab", { name: "Library" }).click();
  await page.getByLabel("Search settings").fill("ntfy");
  await expect(
    page.getByRole("tab", { name: "System", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Search settings").fill("");

  await renamed.getByRole("button", { name: "Delete Phone" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(section.getByRole("listitem")).toHaveCount(0);

  // Members cannot read or change them.
  const ctx = await contextAs(browser, baseURL, "member");
  const denied = await ctx.request.get("/api/notifications");
  expect(denied.status()).toBe(403);
  expect((await denied.json()).code).toBe("admin_required");
  await ctx.close();
});
