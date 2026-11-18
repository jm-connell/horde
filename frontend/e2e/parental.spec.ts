import { contextAs, expect, test, videoCard } from "./fixtures";

test("an admin limits a member to chosen channels", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/account");
  await page.getByRole("button", { name: "Edit member" }).click();
  const controls = page.getByRole("region", {
    name: "Parental controls for member",
  });
  await controls
    .getByRole("switch", { name: "Limit member to chosen channels" })
    .click();
  await controls.getByLabel("Kiln").check();
  await controls.getByRole("button", { name: "Save allowed channels" }).click();
  await expect(page.getByText("member can watch 1 channel")).toBeVisible();

  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  try {
    await member.goto("/");
    await expect(videoCard(member, "Kiln fire").first()).toBeVisible();
    // Other channels are gone, and there is no YouTube search to turn on.
    await expect(videoCard(member, "Aurora Drift")).toHaveCount(0);
    await expect(member.getByRole("switch", { name: /YouTube/ })).toHaveCount(
      0
    );
  } finally {
    await ctx.close();
    // Lift it again for the other specs.
    await controls
      .getByRole("switch", { name: "Limit member to chosen channels" })
      .click();
    await expect(
      page.getByText("member can watch every channel again")
    ).toBeVisible();
  }
});
