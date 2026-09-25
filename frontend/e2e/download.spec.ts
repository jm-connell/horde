import { expect, test } from "./fixtures";

test("download form previews a link and switches destination", async ({
  page,
}) => {
  await page.goto("/download");
  await expect(
    page.getByText("Paste a YouTube or other supported link.")
  ).toBeVisible();
  const download = page.getByRole("button", { name: /^Download( \(|$)/ });
  await expect(download).toBeDisabled();

  await page.getByPlaceholder("Video or playlist URL (YouTube, etc.)").fill(
    "https://example.invalid/watch?v=e2eclip"
  );
  await expect(page.getByPlaceholder("Auto-detected").first()).toHaveValue(
    "E2E preview clip",
    { timeout: 15_000 }
  );
  await expect(page.getByRole("button", { name: "Quality" })).toContainText("720p");
  await expect(download).toBeEnabled();

  await page.getByRole("button", { name: "Quality" }).click();
  await page.getByRole("option", { name: /1080p/ }).click();
  await expect(page.getByRole("button", { name: "Quality" })).toContainText("1080p");

  await page.getByRole("button", { name: "Download to this device" }).click();
  await expect(page.getByRole("button", { name: "Save to device" })).toBeVisible();
  await page.getByRole("button", { name: "Save to library" }).click();
  await expect(download).toBeVisible();
  await expect(page.getByRole("button", { name: "Paste" })).toBeVisible();
});

test("queue shows active, failed, and finished jobs and can pause", async ({
  page,
}) => {
  await page.goto("/download");
  await expect(page.getByText("Queued night drive")).toBeVisible();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause all" }).click();
  await expect(page.getByRole("button", { name: "Resume all" })).toBeVisible();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Recent downloads" })).toBeVisible();
  await expect(page.getByText("Failed extract")).toBeVisible();
  await expect(page.getByText("Bot check", { exact: true })).toBeVisible();
  await expect(page.getByText("Finished kiln tour")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear all" })).toBeVisible();
});
