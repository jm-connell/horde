import { expect, test, videoCard } from "./fixtures";

async function waitForSettingsPatch(page: import("@playwright/test").Page) {
  return page.waitForResponse(
    (response) =>
      response.url().includes("/api/settings") &&
      response.request().method() === "PATCH" &&
      response.ok()
  );
}

test("appearance changes theme and loading animation", async ({ page }) => {
  await page.goto("/settings?tab=appearance");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("option", { name: "OLED (true black)" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oled");

  const comet = page
    .getByRole("group", { name: "Loading animation" })
    .getByRole("button", { name: "Comet" });
  await comet.click();
  await expect(comet).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("A bright head with a fading tail")).toBeVisible();
  await expect(page.getByRole("button", { name: "Font" })).toBeVisible();
  await expect(page.getByLabel("Background animation").first()).toBeVisible();
});

test("settings search jumps to SponsorBlock", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Search settings").fill("sponsorblock");
  await expect(page.getByRole("heading", { name: "SponsorBlock" })).toBeVisible();
  await expect(page.getByText("Enable SponsorBlock")).toBeVisible();
});

test("library settings persist sort default, dates, and progress expiry", async ({
  page,
}) => {
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toContainText("May 14, 2024");

  await page.goto("/settings?tab=library");
  await expect(page.getByRole("heading", { name: "Progress expiry" })).toBeVisible();
  await expect(page.getByText("Show dates on video cards")).toBeVisible();
  await expect(page.getByText("Direct YouTube search")).toBeVisible();

  const dates = page.getByRole("switch", { name: /Show dates on video cards/ });
  const saved = waitForSettingsPatch(page);
  await dates.click();
  await saved;

  const expiry = page
    .getByRole("heading", { name: "Progress expiry" })
    .locator("xpath=..");
  await expiry.getByRole("spinbutton").fill("21");
  const expirySaved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/settings") &&
      response.request().method() === "PATCH" &&
      response.ok()
  );
  await expiry.getByRole("button", { name: "Save" }).click();
  await expirySaved;

  const sort = page
    .getByRole("heading", { name: "Default video sort" })
    .locator("xpath=..");
  const sortSaved = waitForSettingsPatch(page);
  await sort.getByRole("button", { name: "Title", exact: true }).click();
  await sortSaved;

  await page.evaluate(() => localStorage.removeItem("horde.library-sort"));
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).not.toContainText(
    "May 14, 2024"
  );
  await expect(page.getByRole("button", { name: "Sort library" })).toContainText(
    "Title"
  );

  await page.goto("/settings?tab=library");
  await expect(expiry.getByRole("spinbutton")).toHaveValue("21");
});

test("playback settings hide the watch description", async ({ page }) => {
  await page.goto("/");
  await videoCard(page, "Aurora Drift").first().click();
  await expect(page).toHaveURL(/\/watch\//);
  const watchUrl = page.url();
  await expect(page.getByText("Aurora over the ridge line.")).toBeVisible();

  await page.goto("/settings?tab=playback");
  await expect(page.getByRole("button", { name: "Default stream quality" })).toBeVisible();
  await page.getByRole("button", { name: "Default stream quality" }).click();
  await page.getByRole("option", { name: "720p" }).click();
  await expect(
    page.getByRole("button", { name: "Default stream quality" })
  ).toContainText("720p");

  const toggle = page.getByRole("switch", { name: /Show description/ });
  const saved = waitForSettingsPatch(page);
  await toggle.click();
  await saved;

  await page.goto(watchUrl);
  await expect(page.getByText("Aurora over the ridge line.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Cold open/ })).toBeVisible();
});

test("AI panes and system status render without calling providers", async ({
  page,
}) => {
  await page.goto("/settings?tab=ai");
  await expect(page.getByRole("button", { name: "Providers" })).toBeVisible();
  await expect(page.getByRole("button", { name: "OpenRouter", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Features" }).click();
  await expect(page.getByText("AI video summaries")).toBeVisible();
  await expect(page.getByText("AI video chapters")).toBeVisible();
  await page.getByRole("button", { name: "Jobs" }).click();
  await expect(page.getByRole("heading", { name: "Run now" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Automatic" })).toBeVisible();

  await page.goto("/settings?tab=system");
  await expect(page.getByText("yt-dlp", { exact: true })).toBeVisible();
  await expect(page.getByText("Pending import")).toBeVisible();
  await expect(page.getByText("Active downloads")).toBeVisible();
  await expect(page.getByText("Cookies", { exact: true })).toBeVisible();
  await expect(page.getByText("PO token provider")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset Horde…" }).click();
  const dialog = page.getByRole("dialog", { name: "Reset Horde?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox", { name: /Erase all media/ }).check();
  await expect(dialog.getByLabel("Type RESET to confirm")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/tab=system/);
});
