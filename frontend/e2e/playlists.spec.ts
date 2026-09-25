import { expect, test } from "./fixtures";

test("playlists expand, create, and keep the subscribe form closed", async ({
  page,
}) => {
  await page.goto("/playlists");
  await expect(page.getByText("New Horde playlist")).toBeVisible();
  await expect(page.getByText("Subscribe to YouTube playlist")).toBeVisible();
  await expect(page.getByRole("button", { name: "Subscribe" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Max resolution" })).toBeVisible();

  await page.getByRole("heading", { name: "Evening set", level: 3 }).click();
  await expect(page.getByRole("button", { name: "Play all" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Aurora Drift/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Harbor Lights/ })).toBeVisible();

  await page.getByPlaceholder("Playlist name").fill("Weekend mix");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/open=\d+/);
  await expect(page.getByRole("heading", { name: "Weekend mix", level: 3 })).toBeVisible();
  await expect(page.getByText("No videos yet.")).toBeVisible();

  await page.getByPlaceholder("YouTube playlist URL").fill(
    "https://example.invalid/playlist?list=e2e"
  );
  await expect(page.getByRole("button", { name: "Subscribe" })).toBeEnabled();
});
