import { ACCOUNTS } from "./accounts";
import {
  anonymousContext,
  CSRF_HEADERS,
  expect,
  openNav,
  signInWithForm,
  test,
} from "./fixtures";

test("a session ended elsewhere sends the next click to sign-in and back again", async ({
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
  await expect(
    tab.getByRole("link", { name: "Home", exact: true })
  ).toBeVisible();

  // Signing out in another tab ends the session on the server.
  const logout = await ctx.request.post("/api/auth/logout", {
    headers: CSRF_HEADERS,
  });
  expect(logout.ok()).toBeTruthy();

  // The open page does not know yet; its next API call finds out.
  await openNav(tab, "History");
  await expect(tab).toHaveURL(/\/login\?next=%2Fhistory$/);
  await expect(
    tab.getByRole("heading", { name: "Sign in to Horde" })
  ).toBeVisible();

  await signInWithForm(tab, "member", ACCOUNTS.member.password);
  await expect(tab).toHaveURL(/\/history$/);
  await expect(
    tab.getByRole("heading", { name: "History", level: 1 })
  ).toBeVisible();
  await ctx.close();
});
