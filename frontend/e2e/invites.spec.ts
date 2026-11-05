import { anonymousContext, expect, test } from "./fixtures";

test("an invite link lets a new member join and greets them", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/account");
  await page.getByRole("button", { name: "Make an invite link" }).click();
  await page.getByLabel("Who is it for? (optional)").fill("Mum");
  await page.getByRole("button", { name: "Make link" }).click();
  const link = await page
    .getByLabel("Invite link", { exact: true })
    .inputValue();
  expect(link).toMatch(/\/join\?token=/);
  const pending = page.locator('[data-setting="invites"]');
  await expect(pending.getByText("Mum", { exact: true })).toBeVisible();

  const ctx = await anonymousContext(browser, baseURL);
  const guest = await ctx.newPage();
  await guest.goto(new URL(link).pathname + new URL(link).search);
  await expect(
    guest.getByRole("heading", { name: "Join Horde" })
  ).toBeVisible();
  await expect(guest.getByText("For Mum")).toBeVisible();
  await guest.getByLabel("Username").fill("mum");
  await guest.getByLabel("Password", { exact: true }).fill("mum-password");
  await guest.getByLabel("Repeat password").fill("mum-password");
  await guest.getByRole("button", { name: "Create account" }).click();

  // Signed in on Home, with a welcome that stays closed once dismissed.
  const welcome = guest.getByRole("region", { name: "Welcome, mum" });
  await expect(welcome).toBeVisible();
  expect(new URL(guest.url()).pathname).toBe("/");
  await welcome.getByRole("button", { name: "Got it" }).click();
  await expect(welcome).toHaveCount(0);
  await guest.reload();
  await expect(
    guest.getByRole("link", { name: "Home", exact: true })
  ).toBeVisible();
  await expect(welcome).toHaveCount(0);

  // The link worked once.
  const again = await ctx.browser()!.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const second = await again.newPage();
  await second.goto(new URL(link).pathname + new URL(link).search);
  await expect(
    second.getByRole("heading", { name: "This invite doesn’t work" })
  ).toBeVisible();
  await again.close();
  await ctx.close();

  // Used invites leave the pending list.
  await page.reload();
  await expect(pending.getByText("Mum", { exact: true })).toHaveCount(0);
});

test("a revoked invite link stops working", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/account");
  await page.getByRole("button", { name: "Make an invite link" }).click();
  await page.getByRole("button", { name: "Make link" }).click();
  const link = await page
    .getByLabel("Invite link", { exact: true })
    .inputValue();
  const pending = page.locator('[data-setting="invites"]');
  await pending.getByRole("button", { name: "Revoke" }).click();
  await expect(pending.getByText("Unnamed invite")).toHaveCount(0);

  const ctx = await anonymousContext(browser, baseURL);
  const guest = await ctx.newPage();
  await guest.goto(new URL(link).pathname + new URL(link).search);
  await expect(
    guest.getByRole("heading", { name: "This invite doesn’t work" })
  ).toBeVisible();
  await ctx.close();
});
