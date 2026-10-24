import type { Page } from "@playwright/test";
import { ACCOUNTS } from "./accounts";
import { CSRF_HEADERS, expect, test } from "./fixtures";
import { totpCode } from "./totp";

/** Make the admin's session look confirmed long ago, as a stolen cookie's would. */
async function ageSessions(page: Page) {
  const res = await page.request.post("/api/e2e/age-sessions", {
    headers: CSRF_HEADERS,
  });
  expect(res.ok(), await res.text()).toBe(true);
}

async function addUser(page: Page, username: string) {
  await page.goto("/account");
  await page.getByRole("button", { name: "Add a user" }).click();
  await page.getByLabel("Username").fill(username);
  await page
    .getByLabel("Password", { exact: true })
    .fill("reauth-kid-password");
  await page.getByRole("button", { name: "Add user" }).click();
}

test("adding a user after a stale sign-in asks for the password, then goes through", async ({
  page,
}) => {
  await ageSessions(page);
  await addUser(page, "reauthkid");

  const dialog = page.getByRole("dialog", { name: "Confirm your password" });
  await expect(dialog).toBeVisible();
  // Focus starts in the password field, and there is no code field without two-step.
  await expect(dialog.getByLabel("Your password")).toBeFocused();
  await expect(dialog.getByLabel(/Code from your app/)).toHaveCount(0);

  await dialog.getByLabel("Your password").fill("not-my-password");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Current password is incorrect"
  );
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Your password").fill(ACCOUNTS.admin.password);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toHaveCount(0);
  // The original request was sent again: the user exists.
  await expect(page.getByText("Created reauthkid")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit reauthkid" })
  ).toBeVisible();
});

test("cancelling the password prompt leaves everything as it was", async ({
  page,
}) => {
  await ageSessions(page);
  await addUser(page, "nevercreated");
  const dialog = page.getByRole("dialog", { name: "Confirm your password" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Confirm your password to continue")
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit nevercreated" })
  ).toHaveCount(0);
});

test("the dialog traps focus", async ({ page }) => {
  await ageSessions(page);
  await addUser(page, "focustrap");
  const dialog = page.getByRole("dialog", { name: "Confirm your password" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    const inside = await dialog.evaluate((el) =>
      el.contains(document.activeElement)
    );
    expect(inside).toBe(true);
  }
});

test("changing who must use two-step sign-in asks for the password too", async ({
  page,
}) => {
  await ageSessions(page);
  await page.goto("/settings?tab=system");
  await page.getByRole("button", { name: "Everyone", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm your password" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Your password").fill(ACCOUNTS.admin.password);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(
    page.getByText("Everyone must use two-step sign-in")
  ).toBeVisible();
});

test("an account with two-step sign-in is asked for a code as well", async ({
  page,
}) => {
  const setup = await page.request.post("/api/auth/2fa/setup", {
    headers: CSRF_HEADERS,
    data: { current_password: ACCOUNTS.admin.password },
  });
  const secret = ((await setup.json()).secret as string).replace(/\s+/g, "");
  const confirm = await page.request.post("/api/auth/2fa/confirm", {
    headers: CSRF_HEADERS,
    data: { code: totpCode(secret) },
  });
  expect(confirm.ok(), await confirm.text()).toBe(true);
  await ageSessions(page);

  await addUser(page, "twostepkid");
  const dialog = page.getByRole("dialog", { name: "Confirm your password" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Your password").fill(ACCOUNTS.admin.password);
  await dialog.getByLabel(/Code from your app/).fill(totpCode(secret, 1));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Created twostepkid")).toBeVisible();
});

test("a factory reset after a stale sign-in asks for the password above the reset panel", async ({
  page,
}) => {
  await ageSessions(page);
  await page.goto("/settings?tab=system");
  await page.getByRole("button", { name: "Reset Horde…" }).click();
  const reset = page.getByRole("dialog", { name: "Reset Horde?" });
  await reset.getByLabel("Type RESET to confirm").fill("RESET");
  await reset.getByRole("button", { name: "Reset", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Confirm your password" });
  await expect(dialog).toBeVisible();
  // The prompt sits on top of the reset panel, so the field can be used.
  await dialog.getByLabel("Your password").fill("not-my-password");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Current password is incorrect"
  );
  // Cancelling leaves Horde as it was (nothing was reset).
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Confirm your password to continue")
  ).toBeVisible();
  await reset.getByRole("button", { name: "Cancel" }).click();
  await expect(reset).toHaveCount(0);
  await expect(page).toHaveURL(/tab=system/);
});

test("there is no way to set your own password from the users list", async ({
  page,
}) => {
  await page.goto("/account");
  await page.getByRole("button", { name: "Edit admin" }).click();
  await expect(page.getByLabel("New password for admin")).toHaveCount(0);
  await expect(
    page.getByText("Change your own password under Change password")
  ).toBeVisible();
});
