import { test as base, expect, type Page } from "@playwright/test";

/** Mutations from outside the SPA (the test's own API calls) need the CSRF header. */
export const CSRF_HEADERS = { "X-Horde-Request": "1" };

/**
 * Collect Content-Security-Policy violations in the page. Chromium reports a
 * blocked resource as a console error ("Refused to ...") and as a
 * securitypolicyviolation event; either one fails the test.
 */
function watchCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Refused to|Content Security Policy|HORDE_CSP_VIOLATION/i.test(text)) {
      violations.push(text);
    }
  });
  void page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(
        `HORDE_CSP_VIOLATION ${e.violatedDirective} blocked ${e.blockedURI}`
      );
    });
  });
  return violations;
}

/**
 * Seeded app. Each test starts from the same library and empty browser storage,
 * and fails if the page triggers a CSP violation.
 */
export const test = base.extend({
  page: async ({ page, request }, use) => {
    const violations = watchCspViolations(page);
    const reset = await request.post("/api/e2e/reset", {
      headers: CSRF_HEADERS,
    });
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
    expect(violations, "CSP violations").toEqual([]);
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
