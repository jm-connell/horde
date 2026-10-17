import { ACCOUNTS } from "./accounts";
import {
  anonymousContext,
  CSRF_HEADERS,
  contextAs,
  expect,
  signInWithForm,
  test,
  videoCard,
} from "./fixtures";

test("an unsigned visitor lands on the sign-in page and a wrong password is refused", async ({
  page,
  browser,
  baseURL,
}) => {
  // `page` resets the seeded data; the visitor is a separate, cookie-less context.
  void page;
  const ctx = await anonymousContext(browser, baseURL);
  const visitor = await ctx.newPage();
  await visitor.goto("/");
  await expect(visitor).toHaveURL(/\/login\?next=%2F$/);
  await expect(
    visitor.getByRole("heading", { name: "Sign in to Horde" })
  ).toBeVisible();

  await signInWithForm(visitor, "admin", "not-the-password");
  await expect(visitor.locator("form").getByRole("alert")).toHaveText(
    "Wrong username or password."
  );
  await expect(visitor).toHaveURL(/\/login/);

  await signInWithForm(visitor, "admin", ACCOUNTS.admin.password);
  await expect(visitor).toHaveURL(/\/$/);
  await expect(videoCard(visitor, "Aurora Drift").first()).toBeVisible();
  await ctx.close();
});

test("signing out returns to the sign-in page and ends the session", async ({
  page,
  browser,
  baseURL,
}) => {
  void page;
  const ctx = await anonymousContext(browser, baseURL);
  const p = await ctx.newPage();
  await p.goto("/");
  await signInWithForm(p, "admin", ACCOUNTS.admin.password);
  await expect(videoCard(p, "Aurora Drift").first()).toBeVisible();

  await p.getByRole("button", { name: /^admin$/ }).click();
  await p.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(p).toHaveURL(/\/login/);
  const state = await (await ctx.request.get("/api/auth/state")).json();
  expect(state.authenticated).toBe(false);
  await ctx.close();
});

test("a deep link survives the sign-in round trip", async ({
  page,
  browser,
  baseURL,
}) => {
  void page;
  const ctx = await anonymousContext(browser, baseURL);
  const p = await ctx.newPage();
  await p.goto("/playlists");
  await expect(p).toHaveURL(/\/login\?next=%2Fplaylists$/);
  await signInWithForm(p, "member", ACCOUNTS.member.password);
  await expect(p).toHaveURL(/\/playlists$/);
  await expect(
    p.getByRole("heading", { name: "Playlists", level: 1 })
  ).toBeVisible();
  await ctx.close();
});

test("an unsafe next target is ignored", async ({ page, browser, baseURL }) => {
  void page;
  const ctx = await anonymousContext(browser, baseURL);
  const p = await ctx.newPage();
  await p.goto("/login?next=https%3A%2F%2Fevil.example%2F");
  await signInWithForm(p, "member", ACCOUNTS.member.password);
  await expect(p).toHaveURL(new RegExp(`^${baseURL}/$`));
  await ctx.close();
});

test("the admin adds a member, who has their own history", async ({
  page,
  browser,
  baseURL,
}) => {
  // The admin (signed in via storage state) has watched two videos.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Continue watching" })
  ).toBeVisible();

  await page.goto("/account");
  await page.getByRole("button", { name: "Add a user" }).click();
  await page.getByLabel("Username").fill("newbie");
  await page.getByLabel("Password", { exact: true }).fill("newbie-password");
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByText("Created newbie")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit newbie" })).toBeVisible();

  const ctx = await anonymousContext(browser, baseURL);
  const member = await ctx.newPage();
  await member.goto("/");
  await signInWithForm(member, "newbie", "newbie-password");
  // Same shared library, none of the admin's history.
  await expect(videoCard(member, "Aurora Drift").first()).toBeVisible();
  await expect(videoCard(member, "Kiln fire")).toBeVisible();
  await expect(
    member.getByRole("heading", { name: "Continue watching" })
  ).toHaveCount(0);
  await member.goto("/history");
  await expect(member.getByText("No watch history yet.")).toBeVisible();
  await ctx.close();
});

test("an admin cannot demote or disable their own account", async ({
  page,
}) => {
  await page.goto("/account");
  const rows = page.locator('[data-horde="user-row"]');
  const self = rows.filter({ hasText: "(you)" });
  await self.getByRole("button", { name: "Edit admin" }).click();
  await expect(
    self.getByText("You can't remove your own administrator access")
  ).toBeVisible();
  await expect(self.getByRole("radio", { name: "Member" })).toHaveCount(0);
  await expect(
    self.getByRole("button", { name: "Disable account" })
  ).toHaveCount(0);

  // The server refuses it too, not just the UI.
  const state = await page.request.get("/api/auth/state");
  const id = ((await state.json()) as { user: { id: number } }).user.id;
  const res = await page.request.patch(`/api/users/${id}`, {
    data: { is_admin: false },
    headers: CSRF_HEADERS,
  });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { code: string }).code).toBe("self_lockout");

  // Another account can still be edited the usual way.
  await self.getByRole("button", { name: "Close" }).click();
  const other = rows.filter({ hasText: /^member/ });
  await other.getByRole("button", { name: "Edit member" }).click();
  await expect(other.getByRole("radio", { name: "Member" })).toBeVisible();
  await expect(
    other.getByRole("button", { name: "Disable account" })
  ).toBeVisible();
});

test("a member's account settings have no Users section", async ({
  page,
  browser,
  baseURL,
}) => {
  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  // The old Settings deep link lands on Account settings.
  await member.goto("/settings?tab=users");
  await expect(member).toHaveURL(/\/account$/);
  await expect(
    member.getByRole("heading", { name: "Account settings", level: 1 })
  ).toBeVisible();
  await expect(
    member.getByRole("heading", { name: "Change password" })
  ).toBeVisible();
  await expect(member.getByRole("region", { name: "Users" })).toHaveCount(0);
  await expect(member.locator('[data-horde="users-section"]')).toHaveCount(0);

  const resp = await ctx.request.get("/api/users");
  expect(resp.status()).toBe(403);
  await ctx.close();

  // The admin sees it.
  await page.goto("/account");
  await expect(page.getByRole("region", { name: "Users" })).toBeVisible();
});

test("a member without delete_videos sees no delete action", async ({
  page,
  browser,
  baseURL,
  request,
}) => {
  const { items: list } = await (await request.get("/api/videos")).json();
  const id = list.find((v: { title: string }) => v.title === "Kiln fire").id;

  // Admin: Delete is in the actions menu.
  await page.goto(`/watch/${id}`);
  await page.getByTitle("More actions").click();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();

  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto(`/watch/${id}`);
  await member.getByTitle("More actions").click();
  await expect(
    member.getByRole("menuitem", { name: "Edit details" })
  ).toBeVisible();
  await expect(member.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
  const refused = await ctx.request.delete(`/api/videos/${id}`, {
    headers: { "X-Horde-Request": "1" },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe("permission_denied");
  await ctx.close();
});

test("a member without download cannot reach the download page", async ({
  page,
  browser,
  baseURL,
}) => {
  void page;
  const ctx = await contextAs(browser, baseURL, "viewer");
  const viewer = await ctx.newPage();
  await viewer.goto("/");
  await expect(videoCard(viewer, "Kiln fire")).toBeVisible();
  await expect(viewer.getByRole("link", { name: /^Download\b/ })).toHaveCount(
    0
  );
  await viewer.goto("/download");
  await expect(
    viewer.getByRole("heading", { name: "Not available for your account" })
  ).toBeVisible();
  await ctx.close();
});

test("backslash and control-character next targets stay on the site", async ({
  page,
  browser,
  baseURL,
}) => {
  void page;
  for (const next of [
    "/\\evil.example/x",
    "/%09/evil.example",
    "/%0a/evil.example",
  ]) {
    const ctx = await anonymousContext(browser, baseURL);
    const p = await ctx.newPage();
    await p.goto(`/login?next=${encodeURIComponent(decodeURIComponent(next))}`);
    await signInWithForm(p, "member", ACCOUNTS.member.password);
    await expect(p).toHaveURL(new RegExp(`^${baseURL}/$`));
    await ctx.close();
  }
});

test("a different user signing in on a browser that still holds the previous user's preferences does not inherit them", async ({
  page,
  browser,
  baseURL,
}) => {
  void page;
  // The admin picks the OLED theme: stored in this browser and on the server.
  const adminCtx = await contextAs(browser, baseURL, "admin");
  const p = await adminCtx.newPage();
  await p.goto("/settings?tab=appearance");
  const saved = p.waitForResponse((response) => {
    const request = response.request();
    if (
      request.method() !== "PATCH" ||
      !response.url().includes("/api/settings")
    ) {
      return false;
    }
    const body = request.postDataJSON() as { ui?: Record<string, unknown> };
    return body.ui?.theme === "oled";
  });
  await p.getByRole("button", { name: "Theme" }).click();
  await p.getByRole("option", { name: "OLED (true black)" }).click();
  await saved;
  await expect(p.locator("html")).toHaveAttribute("data-theme", "oled");

  // The session ends without a sign-out (cleared cookies, or another tab signed
  // in as someone else), so this browser's cached preferences stay behind.
  await adminCtx.clearCookies();
  const login = await adminCtx.request.post("/api/auth/login", {
    headers: CSRF_HEADERS,
    data: {
      username: ACCOUNTS.member.username,
      password: ACCOUNTS.member.password,
    },
  });
  expect(login.ok()).toBe(true);

  // The member gets their own (default) theme, not the admin's.
  await p.goto("/");
  await expect(videoCard(p, "Aurora Drift").first()).toBeVisible();
  await expect(p.locator("html")).not.toHaveAttribute("data-theme", "oled");
  // Let any sync the page would have started reach the server.
  await p.waitForTimeout(1000);
  const memberUi = (await (await adminCtx.request.get("/api/settings")).json())
    .ui;
  expect(memberUi.theme).not.toBe("oled");
  await adminCtx.close();

  // And the admin's saved preferences on the server are untouched.
  const again = await contextAs(browser, baseURL, "admin");
  const adminUi = (await (await again.request.get("/api/settings")).json()).ui;
  expect(adminUi.theme).toBe("oled");
  await again.close();
});
