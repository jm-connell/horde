import { ACCOUNTS } from "./accounts";
import {
  anonymousContext,
  expect,
  hasChannelRail,
  hasDesktopPlayerChrome,
  openChannel,
  signInWithForm,
  test,
  videoCard,
} from "./fixtures";

// A 2x2 PNG: small, but a real image the server has to decode.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM8oaHBwMDAxAAGAA3qARx2dNdFAAAAAElFTkSuQmCC",
  "base64"
);

/** The account actions: a dropdown on wide screens, the nav panel on phones. */
async function openAccountActions(page: import("@playwright/test").Page) {
  const dropdown = page.locator('[data-horde="account-menu"]');
  const toggle = page.getByRole("button", { name: "Toggle navigation menu" });
  // Wait for the nav to settle on one layout before choosing.
  await expect(dropdown.or(toggle)).toBeVisible();
  if (await dropdown.isVisible()) {
    await dropdown.click();
    return page.getByRole("menu", { name: "Account" });
  }
  await toggle.click();
  return page.locator('[data-horde="nav-menu"]');
}

test("the account menu offers account settings and sign out only", async ({
  page,
}) => {
  await page.goto("/");
  const actions = await openAccountActions(page);
  await expect(
    actions.getByText("Account settings", { exact: true })
  ).toBeVisible();
  await expect(actions.getByText("Sign out", { exact: true })).toBeVisible();
  await expect(actions.getByText("Change password")).toHaveCount(0);

  await actions.getByText("Account settings").click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole("heading", { name: "Account settings", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Change password" })
  ).toBeVisible();
  await expect(page.getByLabel("Current password")).toBeVisible();
  // The add-user form waits behind its button.
  await expect(page.getByLabel("Username")).toHaveCount(0);
  await page.getByRole("button", { name: "Add a user" }).click();
  await expect(page.getByLabel("Username")).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Username")).toHaveCount(0);
});

test("a profile picture can be uploaded and removed", async ({ page }) => {
  await page.goto("/account");
  const profile = page.getByRole("region", { name: "Profile" });
  await expect(profile.locator("img")).toHaveCount(0);

  await profile.getByLabel("Profile picture file").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(page.getByText("Profile picture updated")).toBeVisible();
  const picture = profile.locator('img[src*="/api/auth/avatar/"]');
  await expect(picture).toBeVisible();
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(256);
  // Your own row in the user list shows it too.
  await expect(
    page.locator('[data-horde="user-row"]', { hasText: "(you)" }).locator("img")
  ).toBeVisible();

  await profile.getByRole("button", { name: "Remove picture" }).click();
  await expect(page.getByText("Profile picture removed")).toBeVisible();
  await expect(profile.locator("img")).toHaveCount(0);
});

test("the nav search works from any page and lands on home results", async ({
  page,
}) => {
  test.skip(
    !hasDesktopPlayerChrome(page),
    "phones open search from the nav button"
  );
  await page.goto("/history");
  const search = page.getByRole("searchbox", { name: "Search library" });
  await search.fill("Harbor");
  await expect(page).toHaveURL(/\/$/);
  await expect(search).toBeFocused();
  const matches = page.locator("section").filter({
    has: page.getByRole("button", { name: /In your library/ }),
  });
  await expect(videoCard(matches, "Harbor Lights")).toBeVisible();
  await expect(videoCard(matches, "Aurora Drift")).toHaveCount(0);
});

test("typing in the nav search on a channel opened from the sidebar shows home results", async ({
  page,
}) => {
  test.skip(
    !hasDesktopPlayerChrome(page) || !hasChannelRail(page),
    "needs the channel rail and the nav search box"
  );
  await page.goto("/");
  await openChannel(page, "Northwind");
  await expect(page.getByPlaceholder("Search this channel")).toBeVisible();

  await page.getByRole("searchbox", { name: "Search library" }).fill("Harbor");
  await expect(page.getByPlaceholder("Search this channel")).toHaveCount(0);
  const matches = page.locator("section").filter({
    has: page.getByRole("button", { name: /In your library/ }),
  });
  await expect(videoCard(matches, "Harbor Lights")).toBeVisible();
});

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

test("signing a device out from the account page ends its session", async ({
  page,
  browser,
  baseURL,
}) => {
  // The seeded sessions are shared by every spec, so sign in fresh twice and
  // only ever end the one this test made.
  void page;
  const here = await anonymousContext(browser, baseURL);
  const hereTab = await here.newPage();
  await hereTab.goto("/");
  await signInWithForm(hereTab, "member", ACCOUNTS.member.password);
  await expect(hereTab).toHaveURL(/\/$/);

  const phone = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    userAgent: IPHONE_UA,
    locale: "en-US",
    timezoneId: "UTC",
  });
  const phoneTab = await phone.newPage();
  await phoneTab.goto("/");
  await signInWithForm(phoneTab, "member", ACCOUNTS.member.password);
  await expect(phoneTab).toHaveURL(/\/$/);

  await hereTab.goto("/account");
  const devices = hereTab.getByRole("region", { name: "Signed-in devices" });
  await expect(devices.getByText("This device", { exact: true })).toHaveCount(
    1
  );
  const other = devices
    .locator('[data-horde="session-row"]')
    .filter({ hasText: "Safari on iPhone" });
  await expect(other).toHaveCount(1);
  await expect(other.getByText("This device")).toHaveCount(0);

  await other
    .getByRole("button", { name: /^Sign out Safari on iPhone/ })
    .click();
  await expect(hereTab.getByText("Signed out Safari on iPhone")).toBeVisible();
  await expect(other).toHaveCount(0);

  // The other browser finds out on its next request and is sent to sign-in.
  await phoneTab.goto("/playlists");
  await expect(phoneTab).toHaveURL(/\/login/);
  await expect(
    phoneTab.getByRole("heading", { name: "Sign in to Horde" })
  ).toBeVisible();

  // This one keeps working.
  await hereTab.reload();
  await expect(
    hereTab.getByRole("heading", { name: "Account settings", level: 1 })
  ).toBeVisible();
  await phone.close();
  await here.close();
});

test("an administrator can end a member's session from Users", async ({
  page,
  browser,
  baseURL,
}) => {
  const member = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    userAgent: IPHONE_UA,
    locale: "en-US",
    timezoneId: "UTC",
  });
  const memberTab = await member.newPage();
  await memberTab.goto("/");
  await signInWithForm(memberTab, "member", ACCOUNTS.member.password);
  await expect(memberTab).toHaveURL(/\/$/);

  await page.goto("/account");
  const row = page.locator('[data-horde="user-row"]', { hasText: "member" });
  await row.getByRole("button", { name: "Edit member" }).click();
  const devices = row.getByRole("region", {
    name: "Signed-in devices for member",
  });
  const phone = devices
    .locator('[data-horde="session-row"]')
    .filter({ hasText: "Safari on iPhone" });
  await expect(phone).toHaveCount(1);
  await phone
    .getByRole("button", { name: /^Sign out Safari on iPhone/ })
    .click();
  await expect(phone).toHaveCount(0);

  await memberTab.goto("/playlists");
  await expect(memberTab).toHaveURL(/\/login/);
  await member.close();
});
