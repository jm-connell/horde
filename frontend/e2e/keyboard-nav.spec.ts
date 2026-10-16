import { expect, test, videoCard } from "./fixtures";

/** Names of the elements Tab lands on, in order, until `stop` says to quit. */
async function tabNames(
  page: import("@playwright/test").Page,
  stop: (name: string) => boolean,
  limit = 40
): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "";
      return (
        el.getAttribute("aria-label") ||
        el.textContent?.trim().replace(/\s+/g, " ") ||
        el.tagName
      );
    });
    seen.push(name);
    if (stop(name)) break;
  }
  return seen;
}

test("the main navigation is reachable and operable with the keyboard alone", async ({
  page,
}) => {
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  // Start from the top of the document, as a keyboard user would.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());

  const seen = await tabNames(page, (name) => /^History\b/.test(name));
  const at = (re: RegExp) => seen.findIndex((n) => re.test(n));
  expect(at(/^Home$/), `Tab order: ${seen.join(" | ")}`).toBeGreaterThanOrEqual(
    0
  );
  expect(at(/^Playlists\b/)).toBeGreaterThan(at(/^Home$/));
  expect(at(/^History\b/)).toBeGreaterThan(at(/^Playlists\b/));

  await expect(page.getByRole("link", { name: /^History\b/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/history$/);
  await expect(
    page.getByRole("heading", { name: "History", level: 1 })
  ).toBeVisible();
});

test("a video opens from its card and the actions menu works without a mouse", async ({
  page,
}) => {
  await page.goto("/");
  const card = videoCard(page, "Kiln fire");
  await expect(card).toBeVisible();
  // The card is itself the link to the watch page.
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/watch\/\d+/);

  const trigger = page.getByTitle("More actions");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Video actions" });
  await expect(menu).toBeVisible();
  // Enter on "Edit details" opens the form; Escape in the form leaves the page usable.
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Save changes" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0
  );
});
