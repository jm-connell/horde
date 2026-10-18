import {
  expect,
  hasChannelRail,
  hasDesktopPlayerChrome,
  openChannel,
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
