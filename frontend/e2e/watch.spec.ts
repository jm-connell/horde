import { expect, test, videoCard } from "./fixtures";

test("watch page shows metadata, chapters, and player controls", async ({
  page,
}) => {
  await page.goto("/");
  await videoCard(page, "Aurora Drift").first().click();
  await expect(page).toHaveURL(/\/watch\//);
  await expect(
    page.getByRole("heading", { name: "Aurora Drift", level: 1 })
  ).toBeVisible();
  const channel = page.locator("a").filter({ hasText: /^Northwind$/ });
  await expect(channel).toBeVisible();
  await expect(page.getByText("Aurora over the ridge line.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "0:00 Cold open" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "0:42 Main theme" })
  ).toBeVisible();
  // Chromium may autoplay the seeded file, so the transport starts on Pause.
  await page.locator("video").first().hover();
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  const play = page.getByRole("button", { name: "Play", exact: true });
  await expect(pause.or(play)).toBeVisible();
  if (await pause.isVisible()) await pause.click();
  await expect(play).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mute", exact: true })
  ).toBeVisible();
  await expect(page.getByTitle("Playback speed")).toHaveText("1x");

  await page.getByRole("button", { name: "Theater", exact: true }).click();
  const theater = page.getByRole("button", { name: "Theater", exact: true });
  await expect(theater).toHaveClass(/text-accent/);
  await expect(theater).not.toHaveClass(/text-gray-200/);

  await page.getByTitle("Playback speed").click();
  await page.getByRole("button", { name: "1.5x", exact: true }).click();
  await expect(page.getByTitle("Playback speed")).toHaveText("1.5x");

  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unmute", exact: true })
  ).toBeVisible();

  await channel.click();
  await expect(
    page.getByRole("heading", { name: "Northwind", level: 1 })
  ).toBeVisible();
});

test("watch page can add the video to a playlist", async ({ page }) => {
  await page.goto("/");
  await videoCard(page, "Kiln fire").click();
  await page.getByRole("button", { name: "+ Playlist" }).click();
  await page.getByRole("button", { name: "Evening set" }).click();
  await expect(page.getByText("Added to Evening set")).toBeVisible();

  await page.goto("/playlists");
  await page.getByRole("heading", { name: "Evening set", level: 3 }).click();
  await expect(page.getByRole("link", { name: /Kiln fire/ })).toBeVisible();
});

test("more actions opens edit details", async ({ page }) => {
  await page.goto("/");
  await videoCard(page, "Kiln fire").click();
  await page.getByTitle("More actions").click();
  await page.getByRole("button", { name: "Edit details" }).click();
  await expect(
    page.getByRole("button", { name: "Save changes" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0
  );
  await expect(
    page.getByRole("link", { name: "← Back to library" })
  ).toBeVisible();
});

test("a slow response for the previous video does not replace the current one", async ({
  page,
  request,
}) => {
  const videos: { id: number; title: string }[] = await (
    await request.get("/api/videos")
  ).json();
  const slow = videos.find((v) => v.title === "Aurora Drift")!;
  const current = videos.find((v) => v.title === "Harbor Lights")!;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(new RegExp(`/api/videos/${slow.id}$`), async (route) => {
    await gate;
    await route.continue();
  });

  const slowRequested = page.waitForRequest(
    (req) => new URL(req.url()).pathname === `/api/videos/${slow.id}`
  );
  await page.goto(`/watch/${slow.id}`);
  await slowRequested;
  // Client-side navigation to another video while the first fetch is pending.
  await page.evaluate((id) => {
    window.history.pushState({}, "", `/watch/${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, current.id);
  await expect(
    page.getByRole("heading", { name: current.title, level: 1 })
  ).toBeVisible();

  release();
  // Give the stale response time to land; the page must keep showing the
  // video that is actually being watched.
  await page.waitForTimeout(500);
  await expect(
    page.getByRole("heading", { name: current.title, level: 1 })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: slow.title, level: 1 })
  ).toHaveCount(0);
});
