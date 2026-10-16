import { contextAs, CSRF_HEADERS, expect, test, videoCard } from "./fixtures";

test("one account's watching and dismissals never touch another account's", async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  const { items } = await (await request.get("/api/videos")).json();
  const kiln = items.find((v: { title: string }) => v.title === "Kiln fire");

  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto("/history");
  await expect(member.getByText("No watch history yet.")).toBeVisible();

  // The member watches part of one video.
  const saved = await ctx.request.patch(`/api/videos/${kiln.id}/progress`, {
    headers: CSRF_HEADERS,
    data: { position_sec: 60 },
  });
  expect(saved.ok()).toBeTruthy();
  await member.reload();
  await expect(videoCard(member, "Kiln fire")).toBeVisible();
  await expect(videoCard(member, "Aurora Drift")).toHaveCount(0);

  await member.goto("/");
  const row = member.locator("section").filter({
    has: member.getByRole("heading", { name: "Continue watching" }),
  });
  await expect(videoCard(row, "Kiln fire")).toBeVisible();

  // The admin's history is theirs alone.
  await page.goto("/history");
  await expect(videoCard(page, "Aurora Drift")).toBeVisible();
  await expect(videoCard(page, "Harbor Lights")).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toHaveCount(0);

  // The member clears Kiln fire from the shelf; the admin's shelf is unchanged.
  await row
    .getByRole("button", { name: "Remove from continue watching" })
    .click();
  await expect(
    member.getByRole("heading", { name: "Continue watching" })
  ).toHaveCount(0);
  // Dismissing only hides the shelf entry; the member's history keeps the video.
  await member.goto("/history");
  await expect(videoCard(member, "Kiln fire")).toBeVisible();

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Continue watching" })
  ).toBeVisible();
  await page.goto("/history");
  await expect(videoCard(page, "Aurora Drift")).toBeVisible();
  await ctx.close();
});

test("appearance choices belong to the account that made them", async ({
  page,
  browser,
  baseURL,
}) => {
  const waitForSave = () =>
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/settings") &&
        r.request().method() === "PATCH" &&
        r.ok()
    );

  await page.goto("/settings?tab=appearance");
  const saved = waitForSave();
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("option", { name: "OLED (true black)" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oled");
  await saved;

  // The member starts from the defaults and picks a different theme.
  const memberCtx = await contextAs(browser, baseURL, "member");
  const member = await memberCtx.newPage();
  await member.goto("/settings?tab=appearance");
  await expect(
    member.getByRole("heading", { name: "Settings", level: 1 })
  ).toBeVisible();
  await expect(member.locator("html")).not.toHaveAttribute(
    "data-theme",
    "oled"
  );
  const memberSaved = member.waitForResponse(
    (r) =>
      r.url().includes("/api/settings") &&
      r.request().method() === "PATCH" &&
      r.ok()
  );
  await member.getByRole("button", { name: "Theme" }).click();
  await member.getByRole("option", { name: "Nord" }).click();
  await expect(member.locator("html")).toHaveAttribute("data-theme", "nord");
  await memberSaved;

  // A fresh browser for each account (no shared local storage) gets its own
  // theme back from the server.
  const adminAgain = await contextAs(browser, baseURL, "admin");
  const adminPage = await adminAgain.newPage();
  await adminPage.goto("/");
  await expect(adminPage.locator("html")).toHaveAttribute("data-theme", "oled");
  const memberAgain = await contextAs(browser, baseURL, "member");
  const memberPage = await memberAgain.newPage();
  await memberPage.goto("/");
  await expect(memberPage.locator("html")).toHaveAttribute(
    "data-theme",
    "nord"
  );
  await Promise.all([memberCtx, adminAgain, memberAgain].map((c) => c.close()));
});
