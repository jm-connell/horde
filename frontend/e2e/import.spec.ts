import { expect, feedCard, openNav, test, videoCard } from "./fixtures";

test("import queue approves a dropped file into the library", async ({
  page,
}) => {
  await page.goto("/import");
  await expect(page.getByText("Drop .mp4, .mkv, or .webm files here")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan for New Files" })).toBeVisible();
  await expect(page.locator("input[value='Unreviewed drop']")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save & approve" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Skip" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();

  const channel = page.getByRole("combobox");
  await channel.fill("North");
  await expect(page.getByText("Tab · Northwind")).toBeVisible();
  await channel.press("Tab");
  await expect(channel).toHaveValue("Northwind");
  await page.getByRole("button", { name: "Save & approve" }).click();

  await expect(page.getByText("Nothing to import.")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Import\b/ })).not.toContainText("1");

  await openNav(page, "Home");
  await expect(videoCard(page, "Unreviewed drop")).toBeVisible();
  await page.getByRole("button", { name: /Northwind/ }).click();
  await expect(feedCard(page, "Unreviewed drop")).toBeVisible();
});
