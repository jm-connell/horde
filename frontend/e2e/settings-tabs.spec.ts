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
  ]);
  await tabs.getByRole("tab", { name: "Appearance" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Library" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText("Progress expiry")).toBeVisible();
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: "System" })).toBeFocused();
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    "settings-tab-system"
  );

  // The last tab is remembered when Settings is opened without a deep link.
  await page.goto("/settings");
  await expect(tabs.getByRole("tab", { name: "System" })).toHaveAttribute(
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

test("a provider preset fills the URL and saves it with the key", async ({
  page,
}) => {
  await page.goto("/settings?tab=ai");
  await page.getByRole("button", { name: "AI provider preset" }).click();
  await page
    .getByRole("option", { name: "Ollama (on the Docker host)" })
    .click();
  const url = page.getByLabel("AI provider URL");
  await expect(url).toHaveValue("http://host.docker.internal:11434/v1");

  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/settings") && r.request().method() === "PATCH"
  );
  await page.getByRole("button", { name: "Save without testing" }).click();
  const body = (await (await saved).json()) as {
    ai: { base_url: string; chat_model: string; embed_model: string };
  };
  expect(body.ai.base_url).toBe("http://host.docker.internal:11434/v1");
  // The preset suggests models while none are set.
  expect(body.ai.chat_model).toBe("llama3.2:3b");
  expect(body.ai.embed_model).toBe("nomic-embed-text");

  // Embeddings can move to a second server.
  await page.getByText("Use a different server for embeddings").click();
  await expect(page.getByLabel("Embeddings provider URL")).toBeVisible();
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
