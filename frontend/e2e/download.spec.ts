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

  await page
    .getByPlaceholder("Video or playlist URL (YouTube, etc.)")
    .fill("https://example.invalid/watch?v=e2eclip");
  await expect(page.getByPlaceholder("Auto-detected").first()).toHaveValue(
    "E2E preview clip",
    { timeout: 15_000 }
  );
  await expect(page.getByRole("button", { name: "Quality" })).toContainText(
    "720p"
  );
  await expect(download).toBeEnabled();

  await page.getByRole("button", { name: "Quality" }).click();
  await page.getByRole("option", { name: /1080p/ }).click();
  await expect(page.getByRole("button", { name: "Quality" })).toContainText(
    "1080p"
  );

  await page.getByRole("button", { name: "Offline (this device)" }).click();
  await expect(
    page.getByRole("button", { name: "Download offline" })
  ).toBeVisible();
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

  await expect(
    page.getByRole("heading", { name: "Recent downloads" })
  ).toBeVisible();
  await expect(page.getByText("Failed extract")).toBeVisible();
  await expect(page.getByText("Bot check", { exact: true })).toBeVisible();
  await expect(page.getByText("Finished kiln tour")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear all" })).toBeVisible();
});

test("a download waiting for disk space says why, with a link to the limit", async ({
  page,
}) => {
  const reason = "Paused: library is at its 55 GB limit";
  // The e2e server never dispatches jobs, so hold the seeded queued job by hand.
  await page.route("**/api/downloads", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const jobs = (await response.json()) as {
      status: string;
      held_reason?: string | null;
    }[];
    for (const job of jobs) {
      if (job.status === "queued") job.held_reason = reason;
    }
    await route.fulfill({ response, json: jobs });
  });

  await page.goto("/download");
  await expect(page.getByText("Queued night drive")).toBeVisible();
  await expect(page.getByText("Waiting", { exact: true })).toBeVisible();
  await expect(page.getByText(reason)).toHaveCount(2); // the banner and the card
  await expect(
    page.getByRole("status").filter({ hasText: reason })
  ).toContainText("start by themselves");
  await page.getByRole("link", { name: "Storage settings" }).click();
  await expect(page).toHaveURL(/\/settings\?tab=system/);
});
