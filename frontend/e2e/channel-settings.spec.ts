import type { Page } from "@playwright/test";
import { contextAs, CSRF_HEADERS, expect, test } from "./fixtures";

/**
 * The channel settings sheet: every per-channel option in one place. The
 * suite is offline, so the YouTube-only parts get a channel URL in the browser.
 */
const CHANNEL_URL = "https://www.youtube.com/@kiln";

async function giveKilnAYoutubeUrl(page: Page) {
  await page.route(/\/api\/channels(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const rows = (await response.json()) as { channel: string }[];
    await route.fulfill({
      response,
      json: rows.map((row) =>
        row.channel === "Kiln" ? { ...row, channel_url: CHANNEL_URL } : row
      ),
    });
  });
  await page.route(/\/api\/channels\/feed\?/, (route) =>
    route.fulfill({
      json: {
        channel: "Kiln",
        channel_url: CHANNEL_URL,
        entries: [],
        has_more: false,
      },
    })
  );
  await page.route(/\/api\/live\/channel\?/, (route) =>
    route.fulfill({ json: { live: null } })
  );
}

test("channel settings open from the header and close with Escape", async ({
  page,
}) => {
  await giveKilnAYoutubeUrl(page);
  await page.goto("/?channel=Kiln");
  const gear = page.getByRole("button", { name: "Channel settings" });
  await gear.click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await expect(sheet).toBeVisible();
  for (const heading of [
    "Automatic downloads",
    "Clean up old videos",
    "Live & following",
    "Search",
    "Manage",
  ]) {
    await expect(sheet.getByRole("heading", { name: heading })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(gear).toBeFocused();
});

test("saving an auto-download change shows its chip", async ({ page }) => {
  await giveKilnAYoutubeUrl(page);
  // Saving for real would start a YouTube catalog sync; answer it here.
  let saved: Record<string, unknown> | null = null;
  await page.route(/\/api\/channels\/autodownload$/, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saved = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      json: {
        ...saved,
        configured: true,
        channel_url: CHANNEL_URL,
        channel_name: "Kiln",
        pending_estimate: 0,
        catalog_max_videos: 1000,
      },
    });
  });
  await page.goto("/?channel=Kiln");
  await page.getByRole("button", { name: "Channel settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await sheet
    .getByRole("switch", { name: "Download new uploads automatically" })
    .click();
  await sheet.getByRole("button", { name: "Auto-download resolution" }).click();
  await page.getByRole("option", { name: "720p" }).click();
  await sheet.getByRole("button", { name: "Save automatic downloads" }).click();
  await expect(page.getByText("Automatic downloads saved")).toBeVisible();
  expect(saved).toMatchObject({
    enabled: true,
    quality_preset: "720p",
    previous_mode: "none",
  });

  await page.keyboard.press("Escape");
  const chip = page.getByRole("button", { name: "Auto-download on · 720p" });
  await expect(chip).toBeVisible();
  // A chip opens the sheet at its section.
  await chip.click();
  await expect(
    sheet.getByRole("heading", { name: "Automatic downloads" })
  ).toBeFocused();
});

test("a retention rule previews, saves and shows in the header", async ({
  page,
}) => {
  await page.goto("/?channel=Northwind");
  await page.getByRole("button", { name: "Channel settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  const section = sheet.getByRole("region", { name: "Clean up old videos" });
  await expect(section).toContainText("Always kept");
  await expect(section).toContainText("It is in a playlist");

  await section.getByRole("checkbox", { name: "Keep only the newest" }).check();
  await section
    .getByRole("spinbutton", { name: /Keep only the newest/ })
    .fill("1");
  // Every seeded video was added today, so the exceptions keep them all.
  await expect(section.getByRole("status")).toHaveText(
    /Right now this would move nothing to the trash\. \d+ more are kept by the exceptions below\./
  );

  await section
    .getByRole("switch", { name: "Clean up this channel automatically" })
    .click();
  await section.getByRole("button", { name: "Save cleanup rule" }).click();
  await expect(page.getByText("Cleanup rule saved")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Keeps latest 1" })
  ).toBeVisible();

  // It stuck.
  await page.reload();
  await page.getByRole("button", { name: "Keeps latest 1" }).click();
  await expect(
    sheet.getByRole("switch", { name: "Clean up this channel automatically" })
  ).toBeChecked();
  await expect(
    sheet.getByRole("spinbutton", { name: /Keep only the newest/ })
  ).toHaveValue("1");
});

test("an account without the permissions sees the settings read-only", async ({
  browser,
  baseURL,
}) => {
  const ctx = await contextAs(browser, baseURL, "viewer");
  const page = await ctx.newPage();
  await page.goto("/?channel=Northwind");
  await page.getByRole("button", { name: "Channel settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  const retention = sheet.getByRole("region", { name: "Clean up old videos" });
  await expect(retention).toContainText(
    "Changing this needs the Delete videos permission."
  );
  await expect(
    retention.getByRole("switch", {
      name: "Clean up this channel automatically",
    })
  ).toBeDisabled();
  await expect(
    retention.getByRole("button", { name: "Save cleanup rule" })
  ).toHaveCount(0);
  await expect(sheet.getByLabel("Channel name")).toHaveCount(0);
  await ctx.close();
});

test("renaming into another channel says its cleanup rule was turned off", async ({
  page,
}) => {
  const saved = await page.request.put("/api/channels/retention", {
    headers: CSRF_HEADERS,
    data: { channel: "Kiln", enabled: true, keep_latest: 5 },
  });
  expect(saved.ok()).toBe(true);
  await page.goto("/?channel=Kiln");
  await page.getByRole("button", { name: "Keeps latest 5" }).click();
  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await sheet.getByLabel("Channel name").fill("Northwind");
  await sheet.getByRole("button", { name: "Rename" }).click();
  await expect(
    page.getByText(
      "Retention rules were turned off because the channels were merged"
    )
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Northwind", level: 1 })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Keeps latest/ })).toHaveCount(
    0
  );
});
