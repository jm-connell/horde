import { test as base, expect, type Page } from "@playwright/test";

/** Seeded app. Each test starts from the same library and empty browser storage. */
export const test = base.extend({
  page: async ({ page, request }, use) => {
    const reset = await request.post("/api/e2e/reset");
    if (!reset.ok()) {
      throw new Error(
        `e2e reset failed: ${reset.status()} ${await reset.text()}`
      );
    }
    // Clear once per tab. Later navigations in the same test keep settings
    // the page just saved; the next test gets a fresh page and storage.
    await page.addInitScript(() => {
      const key = "horde-e2e-storage-cleared";
      if (sessionStorage.getItem(key)) return;
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem(key, "1");
    });
    await use(page);
  },
});

export { expect };

export async function openNav(
  page: Page,
  label: "Home" | "Playlists" | "History" | "Download" | "Import" | "Settings"
) {
  const name = label === "Home" ? "Home" : new RegExp(`^${label}\\b`);
  await page.getByRole("link", { name, exact: label === "Home" }).click();
}

export function videoCard(page: Page, title: string) {
  return page.locator("[data-horde='video-card']", { hasText: title });
}

/** Channel pages render feed cards, not library video cards. */
export function feedCard(page: Page, title: string) {
  return page.locator("[data-horde='feed-card']", { hasText: title });
}
