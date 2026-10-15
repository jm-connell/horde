import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * The wizard ignores clicks while it animates between steps and keeps both
 * steps' headings in the DOM until the transition ends; wait for that so a
 * click is never silently dropped.
 */
async function stepSettled(page: Page) {
  await expect(page.locator("main h1")).toHaveCount(1);
}

test("setup wizard walks each step and lands on Download", async ({ page }) => {
  await page.goto("/");
  // Nobody can sign in yet: the first step creates the administrator.
  await expect(
    page.getByRole("heading", { name: "Create the admin account" })
  ).toBeVisible();
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password", { exact: true }).fill("first-password");
  await page.getByLabel("Repeat password").fill("different-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "don’t match"
  );
  await page.getByLabel("Repeat password").fill("first-password");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.getByText("Everyone signs in with their")).toBeVisible();

  // The account step is one-shot: it cannot be used to add a second admin.
  const again = await page.request.post("/api/auth/bootstrap", {
    headers: { "X-Horde-Request": "1" },
    data: { username: "intruder", password: "intruder-password" },
  });
  expect(again.status()).toBe(409);
  await expect(
    page.getByRole("link", { name: "Home", exact: true })
  ).toHaveCount(0);

  await stepSettled(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible();
  await expect(page.getByText("Normalize volume on download")).toBeVisible();

  await stepSettled(page);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await stepSettled(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible();

  await stepSettled(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Playback compatibility" })
  ).toBeVisible();
  const picker = page.getByRole("radiogroup", {
    name: "Playback compatibility",
  });
  await expect(picker.getByRole("radio", { name: /AV1 only/ })).toBeVisible();
  const sidecar = picker.getByRole("radio", { name: /AV1 \+ H\.264 copy/ });
  await sidecar.click();
  await expect(sidecar).toHaveAttribute("aria-checked", "true");

  await stepSettled(page);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible();
  await stepSettled(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Playback compatibility" })
  ).toBeVisible();
  await expect(sidecar).toHaveAttribute("aria-checked", "true");

  await stepSettled(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Look" })).toBeVisible();
  const oled = page.getByRole("button", { name: "OLED (true black)" });
  await oled.click();
  await expect(oled).toHaveAttribute("aria-pressed", "true");

  await stepSettled(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "AI (optional)" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Skip for now" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "OpenRouter" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Local Ollama" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).click();

  await expect(page.getByRole("heading", { name: /You.re set/ })).toBeVisible();
  // The UI syncs settings to the server on a short debounce, so wait for the
  // server state instead of reading it once.
  await expect
    .poll(
      async () =>
        JSON.stringify(await (await page.request.get("/api/settings")).json()),
      { message: "the chosen playback mode reaches the server" }
    )
    .toContain('"sidecar"');
  await page.getByRole("button", { name: "Go to Downloads" }).click();
  await expect(page).toHaveURL(/\/download$/);
  await expect(
    page.getByRole("heading", { name: "Download", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Home", exact: true })
  ).toBeVisible();
});
