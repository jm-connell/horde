import { expectNoSeriousViolations } from "./axe";
import { expect, test } from "./fixtures";

// States a page only reaches after interaction. The plain pages are in a11y.spec.ts.

test("an open playlist with the add-video search has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/playlists");
  await page.getByRole("heading", { name: "Evening set", level: 3 }).click();
  await expect(page.getByRole("link", { name: /Aurora Drift/ })).toBeVisible();
  await page.getByRole("button", { name: "Add video", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search library or paste a download link" })
    .locator("visible=true")
    .fill("Kiln");
  await expect(page.getByRole("option", { name: /Kiln fire/ })).toBeVisible();
  await expectNoSeriousViolations(page, "playlists/open");
});

test("the user editor with its permission list has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/account");
  await page.getByRole("button", { name: "Edit member", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save account type" })
  ).toBeVisible();
  await expectNoSeriousViolations(page, "settings/users/editor");
});

test("the edit-details form has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator("[data-horde='video-card']", { hasText: "Kiln fire" })
    .click();
  await page.getByTitle("More actions").click();
  await page.getByRole("menuitem", { name: "Edit details" }).click();
  await expect(
    page.getByRole("button", { name: "Save changes" })
  ).toBeVisible();
  await expectNoSeriousViolations(page, "watch/edit-details");
});

test("a channel page with its settings sheet open has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/?channel=Northwind");
  await expect(
    page.getByRole("heading", { name: "Northwind", level: 1 })
  ).toBeVisible();
  await expectNoSeriousViolations(page, "library/channel");
  await page.getByRole("button", { name: "Channel settings" }).click();
  await expect(
    page.getByRole("button", { name: "Save cleanup rule" })
  ).toBeVisible();
  await expectNoSeriousViolations(page, "library/channel-settings");
});

test("the expanded History stats have no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/history");
  await page.getByRole("button", { name: /Your stats/ }).click();
  await expect(
    page.getByRole("listbox", { name: /When you watch/ })
  ).toBeVisible();
  await expectNoSeriousViolations(page, "history/stats");
  // The keyboard readout of a chart is part of the page too.
  await page.getByRole("listbox", { name: /Watch time per day/ }).focus();
  await page.keyboard.press("ArrowLeft");
  await expectNoSeriousViolations(page, "history/stats-focused");
});
