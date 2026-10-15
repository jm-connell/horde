import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { storageStatePath, type AccountName } from "./accounts";

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

/** Narrow screens keep the nav links behind a menu button; open it if needed. */
export async function ensureNavVisible(page: Page) {
  const toggle = page.getByRole("button", { name: "Toggle navigation menu" });
  if (await toggle.isVisible()) {
    const expanded = await toggle.getAttribute("aria-expanded");
    if (expanded !== "true") await toggle.click();
  }
}

export async function openNav(
  page: Page,
  label: "Home" | "Playlists" | "History" | "Download" | "Import" | "Settings"
) {
  await ensureNavVisible(page);
  const name = label === "Home" ? "Home" : new RegExp(`^${label}\\b`);
  await page.getByRole("link", { name, exact: label === "Home" }).click();
}

/** The channel rail is `md:block` (768px); phones reach a channel via its URL/cards. */
export function hasChannelRail(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 768;
}

/** Phones drop the volume slider and the theater/fit buttons from the player. */
export function hasDesktopPlayerChrome(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 768;
}

/** Open a channel page from Home: rail button on desktop, `?channel=` on phones. */
export async function openChannel(page: Page, name: string) {
  if (hasChannelRail(page)) {
    await page.getByRole("button", { name: new RegExp(name) }).click();
  } else {
    await page.goto(`/?channel=${encodeURIComponent(name)}`);
  }
}

/** The header search box is behind a button on narrow screens. */
export async function openSearchBox(page: Page) {
  // Wide and narrow layouts each render a search input; only one is visible.
  const box = page
    .getByPlaceholder("Search", { exact: true })
    .locator("visible=true");
  if (await box.count()) return box;
  // After tapping a tag the page may have scrolled; the header lives at the top.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Search", exact: true }).click();
  return box;
}

export function videoCard(page: Page, title: string) {
  return page.locator("[data-horde='video-card']", { hasText: title });
}

/** Channel pages render feed cards, not library video cards. */
export function feedCard(page: Page, title: string) {
  return page.locator("[data-horde='feed-card']", { hasText: title });
}

/** A browser context already signed in as one of the seeded accounts. */
export async function contextAs(
  browser: Browser,
  baseURL: string | undefined,
  name: AccountName
): Promise<BrowserContext> {
  return browser.newContext({
    baseURL,
    storageState: storageStatePath(name),
    locale: "en-US",
    timezoneId: "UTC",
  });
}

/** A context with no cookies, as a visitor who has not signed in. */
export async function anonymousContext(
  browser: Browser,
  baseURL: string | undefined
): Promise<BrowserContext> {
  return browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    locale: "en-US",
    timezoneId: "UTC",
  });
}

/** Sign in through the login form. */
export async function signInWithForm(
  page: Page,
  username: string,
  password: string
): Promise<void> {
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
