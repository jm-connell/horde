import type { APIRequestContext, Page } from "@playwright/test";
import {
  anonymousContext,
  CSRF_HEADERS,
  expect,
  test,
  videoCard,
} from "./fixtures";
import { totpCode } from "./totp";

const PASSWORD = "two-step-password";

/** A member made through the API; the next reset removes it again. */
async function createUser(admin: APIRequestContext, username: string) {
  const res = await admin.post("/api/users", {
    headers: CSRF_HEADERS,
    data: { username, password: PASSWORD },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as { id: number };
}

async function signOut(page: Page, username: string) {
  await page.getByRole("button", { name: new RegExp(`^${username}$`) }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Set up two-step sign-in in Account settings; returns the key and recovery codes. */
async function enroll(page: Page) {
  await page.goto("/account");
  const section = page.locator('[data-horde="two-factor"]');
  await section
    .getByRole("button", { name: "Set up two-step sign-in" })
    .click();
  await section.getByLabel("Current password").fill(PASSWORD);
  await section.getByRole("button", { name: "Continue" }).click();
  await expect(section.getByRole("img", { name: /QR code/ })).toBeVisible();
  const secret = (
    await section.locator('[data-horde="totp-secret"]').innerText()
  ).replace(/\s+/g, "");
  await section.getByLabel("6-digit code").fill(totpCode(secret));
  await section
    .getByRole("button", { name: "Turn on two-step sign-in" })
    .click();
  await expect(section.getByRole("status").first()).toHaveText(
    "Two-step sign-in is on."
  );
  const codes = await section
    .getByRole("list", { name: "Recovery codes" })
    .getByRole("listitem")
    .allInnerTexts();
  expect(codes).toHaveLength(10);
  await section
    .getByRole("button", { name: "I have saved these codes" })
    .click();
  await expect(section.getByText(/10 of 10 recovery codes left/)).toBeVisible();
  return { secret, codes };
}

test("two-step sign-in: set up, sign in with a code, then with a recovery code", async ({
  page,
  browser,
  baseURL,
}) => {
  await createUser(page.request, "twostep");
  const ctx = await anonymousContext(browser, baseURL);
  const p = await ctx.newPage();
  await p.goto("/login?username=twostep&next=%2Fplaylists");
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  await expect(p).toHaveURL(/\/playlists$/);

  const { secret, codes } = await enroll(p);
  await signOut(p, "twostep");

  // Password right: the code step, with the name and the redirect kept.
  await p.goto("/login?username=twostep&next=%2Fplaylists");
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  await expect(
    p.getByRole("heading", { name: "Two-step sign-in" })
  ).toBeVisible();
  const field = p.getByLabel("6-digit code");
  await expect(field).toHaveAttribute("autocomplete", "one-time-code");
  await expect(field).toBeFocused();

  // A wrong code is refused with a message and the form stays.
  await field.fill("000000");
  await p.getByRole("button", { name: "Verify" }).click();
  await expect(p.locator("form").getByRole("alert")).toContainText(
    "didn’t work"
  );

  // The step used to turn it on is spent: the next one signs in.
  await field.fill(totpCode(secret, 1));
  await p.getByRole("button", { name: "Verify" }).click();
  await expect(p).toHaveURL(/\/playlists$/);
  await signOut(p, "twostep");

  // A recovery code, once.
  await p.goto("/login?username=twostep");
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.getByRole("button", { name: "Use a recovery code" }).click();
  await p.getByLabel("Recovery code").fill(codes[0]!);
  await p.getByRole("button", { name: "Verify" }).click();
  await expect(videoCard(p, "Aurora Drift").first()).toBeVisible();
  await signOut(p, "twostep");

  await p.goto("/login?username=twostep");
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.getByRole("button", { name: "Use a recovery code" }).click();
  await p.getByLabel("Recovery code").fill(codes[0]!);
  await p.getByRole("button", { name: "Verify" }).click();
  await expect(p.locator("form").getByRole("alert")).toContainText(
    "already used"
  );
  await ctx.close();
});

test("turning two-step sign-in off needs the password and a code", async ({
  page,
  browser,
  baseURL,
}) => {
  await createUser(page.request, "twooff");
  const ctx = await anonymousContext(browser, baseURL);
  const p = await ctx.newPage();
  await p.goto("/login?username=twooff");
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  await expect(videoCard(p, "Aurora Drift").first()).toBeVisible();
  const { secret } = await enroll(p);

  const section = p.locator('[data-horde="two-factor"]');
  await section.getByRole("button", { name: "Turn off", exact: true }).click();
  await section.getByLabel("Current password").fill(PASSWORD);
  await section.getByLabel(/Code from your app/).fill(totpCode(secret, 1));
  await section
    .getByRole("button", { name: "Turn off two-step sign-in" })
    .click();
  await expect(
    section.getByRole("button", { name: "Set up two-step sign-in" })
  ).toBeVisible();
  await ctx.close();
});

test("when it is required, an account without it can only set it up", async ({
  page,
  browser,
  baseURL,
}) => {
  await createUser(page.request, "mustenroll");
  const set = await page.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { require_two_factor: "everyone" },
  });
  expect(set.ok()).toBe(true);

  const ctx = await anonymousContext(browser, baseURL);
  const p = await ctx.newPage();
  await p.goto("/login?username=mustenroll&next=%2Fplaylists");
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  await expect(
    p.getByRole("heading", { name: "Set up two-step sign-in" })
  ).toBeVisible();
  // The server holds the rest back, not just the screen.
  const blocked = await ctx.request.get("/api/videos");
  expect(blocked.status()).toBe(403);
  expect((await blocked.json()).code).toBe("two_factor_enrollment_required");
  await p.goto("/playlists");
  await expect(
    p.getByRole("heading", { name: "Set up two-step sign-in" })
  ).toBeVisible();

  await p.getByLabel("Current password").fill(PASSWORD);
  await p.getByRole("button", { name: "Continue" }).click();
  const secret = (
    await p.locator('[data-horde="totp-secret"]').innerText()
  ).replace(/\s+/g, "");
  await p.getByLabel("6-digit code").fill(totpCode(secret));
  await p.getByRole("button", { name: "Turn on two-step sign-in" }).click();
  await p.getByRole("button", { name: "I have saved these codes" }).click();
  // Now the app is available.
  await expect(
    p.getByRole("heading", { name: "Set up two-step sign-in" })
  ).toHaveCount(0);
  await expect(p).toHaveURL(/\/playlists$/);
  expect((await ctx.request.get("/api/videos")).status()).toBe(200);
  await ctx.close();
});

test("an administrator can reset a member's two-step sign-in", async ({
  page,
  browser,
  baseURL,
}) => {
  await createUser(page.request, "lostphone");
  // Enrol that account through the API, as its owner would.
  const ctx = await anonymousContext(browser, baseURL);
  const login = await ctx.request.post("/api/auth/login", {
    headers: CSRF_HEADERS,
    data: { username: "lostphone", password: PASSWORD },
  });
  expect(login.ok()).toBe(true);
  const setup = await ctx.request.post("/api/auth/2fa/setup", {
    headers: CSRF_HEADERS,
    data: { current_password: PASSWORD },
  });
  const secret = ((await setup.json()).secret as string).replace(/\s+/g, "");
  const confirm = await ctx.request.post("/api/auth/2fa/confirm", {
    headers: CSRF_HEADERS,
    data: { code: totpCode(secret) },
  });
  expect(confirm.ok()).toBe(true);

  await page.goto("/account");
  const row = page.locator('[data-horde="user-row"]', { hasText: "lostphone" });
  await expect(row.getByText("Two-step", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Edit lostphone" }).click();
  await row.getByRole("button", { name: "Reset two-step sign-in" }).click();
  await page
    .getByRole("button", { name: "Reset two-step sign-in" })
    .last()
    .click();
  await expect(
    page.getByText("Two-step sign-in is off for lostphone")
  ).toBeVisible();
  await expect(row.getByText("Two-step", { exact: true })).toHaveCount(0);

  // The password alone signs them in again.
  const again = await ctx.request.post("/api/auth/login", {
    headers: CSRF_HEADERS,
    data: { username: "lostphone", password: PASSWORD },
  });
  expect(again.status()).toBe(200);
  await ctx.close();
});

test("the security checklist is on the System tab", async ({ page }) => {
  await page.goto("/settings?tab=system");
  const card = page.locator('[data-horde="security-checklist"]');
  await expect(card.getByText("Opened over HTTPS")).toBeVisible();
  // The e2e server runs over plain HTTP.
  await expect(
    card.locator("li", { hasText: "Opened over HTTPS" })
  ).toHaveAttribute("data-status", "warn");
  await expect(
    card.locator("li", { hasText: "Sign-in is on" })
  ).toHaveAttribute("data-status", "ok");
  await page.getByRole("button", { name: "Everyone", exact: true }).click();
  await expect(
    page.getByText("Everyone must use two-step sign-in")
  ).toBeVisible();
});
