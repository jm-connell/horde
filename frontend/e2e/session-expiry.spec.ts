import { ACCOUNTS } from "./accounts";
import {
  anonymousContext,
  CSRF_HEADERS,
  expect,
  openNav,
  signInWithForm,
  test,
} from "./fixtures";

test("a session ended elsewhere sends the open page to sign-in and back again", async ({
  page,
  browser,
  baseURL,
}) => {
  // The seeded sessions are shared by every spec, so sign in fresh and end that one.
  void page;
  const ctx = await anonymousContext(browser, baseURL);
  const tab = await ctx.newPage();
  await tab.goto("/");
  await signInWithForm(tab, "member", ACCOUNTS.member.password);
  await expect(tab).toHaveURL(/\/$/);
  const playlist = tab.getByRole("heading", { name: "Evening set", level: 3 });
  await openNav(tab, "Playlists");
  await expect(
    tab.getByRole("heading", { name: "Playlists", level: 1 })
  ).toBeVisible();
  await expect(playlist).toBeVisible();

  // Signing out in another tab ends the session on the server.
  const logout = await ctx.request.post("/api/auth/logout", {
    headers: CSRF_HEADERS,
  });
  expect(logout.ok()).toBeTruthy();

  // The open page may not know yet. Anything that calls the API finds out (a
  // background refresh can get there first), and the page being left is kept.
  await expect(async () => {
    if (!/\/login/.test(tab.url())) await playlist.click({ timeout: 1_000 });
    await expect(tab).toHaveURL(/\/login\?next=%2Fplaylists/, {
      timeout: 2_000,
    });
  }).toPass();
  await expect(
    tab.getByRole("heading", { name: "Sign in to Horde" })
  ).toBeVisible();

  await signInWithForm(tab, "member", ACCOUNTS.member.password);
  await expect(tab).toHaveURL(/\/playlists(\?|$)/);
  await expect(
    tab.getByRole("heading", { name: "Playlists", level: 1 })
  ).toBeVisible();
  await ctx.close();
});
