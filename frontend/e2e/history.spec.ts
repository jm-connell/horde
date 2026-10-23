import { contextAs, expect, test, videoCard } from "./fixtures";

test("history groups watched videos by day and omits unwatched ones", async ({
  page,
}) => {
  await page.goto("/history");
  await expect(
    page.getByRole("heading", { name: "History", level: 1 })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Yesterday" })).toBeVisible();
  await expect(videoCard(page, "Aurora Drift")).toBeVisible();
  await expect(videoCard(page, "Harbor Lights")).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toHaveCount(0);
  await expect(page.getByText("No watch history yet.")).toHaveCount(0);
});

test("the stats band sums up the seeded watching and opens to charts", async ({
  page,
}) => {
  await page.goto("/history");
  const band = page.getByRole("button", { name: /Your stats/ });
  await expect(band).toHaveAttribute("aria-expanded", "false");
  // e2e_seed.WATCH_TIME_SEED: 119 minutes in the last 7 days, a 4-day streak,
  // five videos finished and Kiln ahead of Northwind in the last 30 days.
  await expect(band).toContainText("1h 59m");
  await expect(band).toContainText("4 days");
  await expect(band).toContainText("Kiln");
  await expect(band).toContainText("Videos finished5");

  await band.click();
  await expect(band).toHaveAttribute("aria-expanded", "true");
  const chart = page.getByRole("listbox", { name: /Watch time per day/ });
  await expect(chart).toBeVisible();
  await expect(chart.getByRole("option")).toHaveCount(30);
  await expect(
    page.getByRole("link", { name: /Northwind/ }).first()
  ).toHaveAttribute("href", "/?channel=Northwind");
  await expect(
    page.getByRole("listbox", { name: /When you watch/ })
  ).toBeVisible();

  // Keyboard: the chart reads one bar at a time, starting with today.
  await chart.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(chart.getByRole("option", { selected: true })).toHaveAttribute(
    "aria-label",
    /: 25 minutes, 1 finished$/
  );

  await page.getByRole("button", { name: "7 days" }).click();
  await expect(chart.getByRole("option")).toHaveCount(7);
  await page.getByRole("button", { name: "Year" }).click();
  await expect(
    page.getByRole("listbox", { name: /Watch time per week/ })
  ).toBeVisible();

  // Remembered for the account.
  await page.reload();
  await expect(
    page.getByRole("button", { name: /Your stats/ })
  ).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: /Your stats/ }).click();
  await expect(
    page.getByRole("button", { name: /Your stats/ })
  ).toHaveAttribute("aria-expanded", "false");
  // Folded away: out of reach of the keyboard and assistive tech.
  const details = await page
    .getByRole("button", { name: /Your stats/ })
    .getAttribute("aria-controls");
  await expect(page.locator(`[id="${details}"]`).locator("..")).toHaveAttribute(
    "inert",
    ""
  );
});

test("a member who has watched nothing gets the empty stats", async ({
  browser,
  baseURL,
}) => {
  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto("/history");
  await expect(
    member.getByText("Watch something and your stats will show up here.")
  ).toBeVisible();
  await expect(member.getByText("1h 59m")).toHaveCount(0);
  await ctx.close();
});
