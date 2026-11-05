import { expect, openNav, test } from "./fixtures";

test("adding a channel by handle follows it and can turn on auto-download", async ({
  page,
}) => {
  await page.goto("/");
  await openNav(page, "Subscriptions");
  await expect(
    page.getByRole("heading", { name: "Subscriptions", level: 1 })
  ).toBeVisible();

  await page.getByLabel("Add a YouTube channel").fill("@e2enewchannel");
  await page.getByLabel(/Also download its new uploads automatically/).check();
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(
    page.getByText(/new uploads will download by themselves/)
  ).toBeVisible();

  const list = page.getByRole("list", { name: "Subscriptions" });
  const row = list.getByRole("listitem").filter({ hasText: "e2enewchannel" });
  await expect(row.getByRole("button", { name: "Following" })).toBeVisible();
  const auto = row.getByRole("button", { name: /Auto-download on · 1080p/ });
  await expect(auto).toHaveAttribute("aria-pressed", "true");

  await auto.click();
  await expect(
    row.getByRole("button", { name: "Auto-download off" })
  ).toBeVisible();

  await row.getByRole("button", { name: "Following" }).click();
  await expect(row.getByRole("button", { name: "Follow" })).toBeVisible();
});

test("Settings on a subscription opens the channel's settings sheet", async ({
  page,
}) => {
  await page.goto("/subscriptions");
  await page.getByLabel("Add a YouTube channel").fill("@e2esheetchannel");
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  const row = page
    .getByRole("list", { name: "Subscriptions" })
    .getByRole("listitem")
    .filter({ hasText: "e2esheetchannel" });
  await row.getByRole("link", { name: "Settings" }).click();

  const sheet = page.getByRole("dialog", { name: "Channel settings" });
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole("heading", { name: "Automatic downloads" })
  ).toBeVisible();
  // The one-time ?settings= is gone, so a reload does not reopen the sheet.
  await expect
    .poll(() => new URL(page.url()).searchParams.has("settings"))
    .toBe(false);
});

test("turning auto-download on here asks for new uploads only", async ({
  page,
}) => {
  await page.goto("/subscriptions");
  await page.getByLabel("Add a YouTube channel").fill("@e2ebackfill");
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  const row = page
    .getByRole("list", { name: "Subscriptions" })
    .getByRole("listitem")
    .filter({ hasText: "e2ebackfill" });
  await expect(row.getByRole("button", { name: "Following" })).toBeVisible();
  // An earlier, switched-off policy that would download every older video.
  const saved = await page.request.put("/api/channels/autodownload", {
    headers: { "X-Horde-Request": "1" },
    data: {
      url: "https://www.youtube.com/@e2ebackfill",
      enabled: false,
      previous_mode: "all",
      quality_preset: "720p",
      include_completed_streams: false,
    },
  });
  expect(saved.ok()).toBeTruthy();

  const sent = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/channels/autodownload") && r.method() === "PUT"
  );
  await row.getByRole("button", { name: "Auto-download off" }).click();
  const body = (await sent).postDataJSON() as {
    enabled: boolean;
    previous_mode: string;
    quality_preset: string;
  };
  expect(body).toMatchObject({
    enabled: true,
    previous_mode: "none",
    quality_preset: "720p",
  });
});
