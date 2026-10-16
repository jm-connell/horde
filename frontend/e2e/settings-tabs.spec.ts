import { expect, test } from "./fixtures";

test("the tab bar moves with the arrow keys and keeps the chosen tab", async ({
  page,
}) => {
  await page.goto("/settings?tab=appearance");
  const tabs = page.getByRole("tablist", { name: "Settings sections" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "Appearance",
    "Library",
    "Playback",
    "AI",
    "System",
    "Users",
  ]);
  await tabs.getByRole("tab", { name: "Appearance" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Library" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText("Progress expiry")).toBeVisible();
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: "Users" })).toBeFocused();
  await expect(page.locator('[data-horde="users-tab"]')).toBeVisible();

  // The last tab is remembered when Settings is opened without a deep link.
  await page.goto("/settings");
  await expect(tabs.getByRole("tab", { name: "Users" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

test("a deep link opens the AI jobs pane and a search jumps to another tab", async ({
  page,
}) => {
  await page.goto("/settings?tab=ai&pane=jobs");
  await expect(page.getByRole("heading", { name: "Run now" })).toBeVisible();
  await page.getByLabel("Search settings").fill("progress expiry");
  await expect(page.getByRole("tab", { name: "Library" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(
    page.getByRole("heading", { name: "Progress expiry" })
  ).toBeVisible();
});

test("a theme saved on the appearance tab can be applied and deleted", async ({
  page,
}) => {
  await page.goto("/settings?tab=appearance");
  await page.getByLabel("Theme name").fill("Evening");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved theme “Evening”")).toBeVisible();
  await expect(page.getByLabel("Theme name")).toHaveValue("");
  const row = page.getByRole("listitem").filter({ hasText: "Evening" });
  await row.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Applied “Evening”")).toBeVisible();
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
});

test("the AI provider sub-pane is still selected after visiting another tab", async ({
  page,
}) => {
  await page.goto("/settings?tab=ai");
  await page.getByRole("button", { name: "OpenRouter", exact: true }).click();
  const costs = page.getByRole("heading", { name: "OpenRouter costs" });
  await expect(costs).toBeVisible();
  await page.getByRole("tab", { name: "Library" }).click();
  await expect(page.getByText("Progress expiry")).toBeVisible();
  await page.getByRole("tab", { name: "AI" }).click();
  await expect(costs).toBeVisible();
});

test("a closed settings tab stops polling its status", async ({ page }) => {
  let polls = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/ai/status") polls += 1;
  });
  await page.goto("/settings?tab=ai");
  // The AI tab polls every 5 s while it is open.
  await expect.poll(() => polls, { timeout: 15_000 }).toBeGreaterThan(1);
  await page.getByRole("tab", { name: "Library" }).click();
  await expect(page.getByText("Progress expiry")).toBeVisible();
  const after = polls;
  await page.waitForTimeout(7_000);
  expect(polls).toBe(after);
});
