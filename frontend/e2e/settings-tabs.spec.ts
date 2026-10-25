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

test("a pasted server address or API key is recognised and saved", async ({
  page,
}) => {
  await page.goto("/settings?tab=ai");
  const field = page.getByLabel("AI provider URL or API key");
  const savedAi = async () => {
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/settings") && r.request().method() === "PATCH"
    );
    await page.getByRole("button", { name: "Save without testing" }).click();
    return (
      (await (await saved).json()) as {
        ai: {
          base_url: string;
          api_key_set: boolean;
          chat_model: string;
          embed_model: string;
        };
      }
    ).ai;
  };

  // A bare address on Ollama's port: http:// and /v1 are added, and Ollama's
  // starting models are suggested while none are set.
  await field.fill("host.docker.internal:11434");
  let ai = await savedAi();
  expect(ai.base_url).toBe("http://host.docker.internal:11434/v1");
  expect(ai.chat_model).toBe("llama3.2:3b");
  expect(ai.embed_model).toBe("nomic-embed-text");

  // A key with a known prefix stands for its provider; no URL or key field.
  await field.fill("sk-or-e2e-placeholder");
  await expect(page.getByText("OpenRouter key")).toBeVisible();
  await expect(page.getByLabel("AI provider API key")).toHaveCount(0);
  ai = await savedAi();
  expect(ai.base_url).toBe("https://openrouter.ai/api/v1");
  expect(ai.api_key_set).toBe(true);
  await expect(field).toHaveValue("https://openrouter.ai/api/v1");

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
