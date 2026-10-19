import { expect, test } from "./fixtures";

// A refused request carries the server's own sentence; the page has to show it
// instead of a generic failure.

test("refusing to delete the last administrator shows the server's reason in a toast", async ({
  page,
}) => {
  await page.goto("/account");
  await page.getByRole("button", { name: "Edit admin", exact: true }).click();
  await page.getByRole("button", { name: "Delete user" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete admin?" });
  await dialog.getByRole("button", { name: "Delete user" }).click();

  await expect(
    page.getByRole("alert").filter({
      hasText: "This is the last administrator and cannot be deleted",
    })
  ).toBeVisible();
  // The account is still there.
  await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(page.getByText("Deleted admin")).toHaveCount(0);
});

test("adding a user with a taken name shows the reason next to the form", async ({
  page,
}) => {
  await page.goto("/account");
  await page.getByRole("button", { name: "Add a user" }).click();
  await page.getByLabel("Username").fill("member");
  await page.getByLabel("Password", { exact: true }).fill("another-password");
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(
    page.locator("form").getByRole("alert").filter({ hasText: "already taken" })
  ).toBeVisible();
  await expect(page.getByText("Created member")).toHaveCount(0);
});

test("queueing a link that is already queued says so instead of failing silently", async ({
  page,
}) => {
  await page.goto("/download");
  await page
    .getByPlaceholder("Video or playlist URL (YouTube, etc.)")
    .fill("https://example.invalid/queued-night-drive");
  const download = page.getByRole("button", { name: /^Download( \(|$)/ });
  await expect(download).toBeEnabled();
  await download.click();
  await expect(page.getByText("Already queued")).toBeVisible();
});
