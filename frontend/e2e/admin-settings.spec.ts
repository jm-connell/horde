import { contextAs, CSRF_HEADERS, expect, test } from "./fixtures";

test("the playback compatibility panel is for administrators only", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/settings?tab=library");
  await expect(
    page.getByRole("radiogroup", { name: "Playback compatibility" })
  ).toBeVisible();

  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto("/settings?tab=library");
  await expect(
    member.getByRole("heading", { name: "Display", level: 2 })
  ).toBeVisible();
  await expect(
    member.getByRole("radiogroup", { name: "Playback compatibility" })
  ).toHaveCount(0);
  // Searching for it does not reveal it either.
  await member.getByLabel("Search settings").fill("codec");
  await expect(
    member.getByRole("radiogroup", { name: "Playback compatibility" })
  ).toHaveCount(0);

  // The server refuses the change, and the library totals behind the panel.
  const refused = await ctx.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { ui: { download_video_codec: "sidecar" } },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe("admin_required");
  expect((await ctx.request.get("/api/compat/summary")).status()).toBe(403);
  await ctx.close();
});
