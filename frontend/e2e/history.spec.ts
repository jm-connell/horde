import { expect, test, videoCard } from "./fixtures";

test("history groups watched videos by day and omits unwatched ones", async ({
  page,
}) => {
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Yesterday" })).toBeVisible();
  await expect(videoCard(page, "Aurora Drift")).toBeVisible();
  await expect(videoCard(page, "Harbor Lights")).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toHaveCount(0);
  await expect(page.getByText("No watch history yet.")).toHaveCount(0);
});
