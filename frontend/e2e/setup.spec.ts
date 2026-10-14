import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  const reset = await request.post("/api/e2e/reset");
  if (!reset.ok()) {
    throw new Error(`e2e reset failed: ${reset.status()} ${await reset.text()}`);
  }
  await page.addInitScript(() => {
    const key = "horde-e2e-storage-cleared";
    if (sessionStorage.getItem(key)) return;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem(key, "1");
  });
});

test("setup wizard walks each step and lands on Download", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.getByText("There is no login")).toBeVisible();
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible();
  await expect(page.getByText("Normalize volume on download")).toBeVisible();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Playback compatibility" })).toBeVisible();
  const picker = page.getByRole("radiogroup", { name: "Playback compatibility" });
  await expect(picker.getByRole("radio", { name: /AV1 only/ })).toBeVisible();
  const sidecar = picker.getByRole("radio", { name: /AV1 \+ H\.264 copy/ });
  await sidecar.click();
  await expect(sidecar).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(sidecar).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Look" })).toBeVisible();
  const oled = page.getByRole("button", { name: "OLED (true black)" });
  await oled.click();
  await expect(oled).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "AI (optional)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "OpenRouter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Local Ollama" })).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).click();

  await expect(page.getByRole("heading", { name: /You.re set/ })).toBeVisible();
  const settings = await (await page.request.get("/api/settings")).json();
  expect(JSON.stringify(settings)).toContain('"sidecar"');
  await page.getByRole("button", { name: "Go to Downloads" }).click();
  await expect(page).toHaveURL(/\/download$/);
  await expect(page.getByRole("heading", { name: "Download", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
});
