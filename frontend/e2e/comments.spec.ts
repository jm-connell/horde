import { expect, openSearchBox, test, videoCard } from "./fixtures";
import type { Page, Route } from "@playwright/test";

/** The seeded id of the library video called `title`. */
async function videoId(page: Page, title: string): Promise<number> {
  const list = await page.request.get("/api/videos?limit=500");
  const item = (await list.json()).items.find(
    (v: { title: string }) => v.title === title
  );
  return item.id;
}

test("saved comments show under the video, creator's note first, replies on request", async ({
  page,
}) => {
  await page.goto(`/watch/${await videoId(page, "Cedar Notes")}`);
  const panel = page.getByRole("region", { name: /Comments/ });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading")).toHaveText("Comments 2.4K");

  const threads = panel.locator(":scope > ol > li");
  await expect(threads).toHaveCount(5);
  const pinned = threads.first();
  await expect(pinned).toContainText("Pinned");
  await expect(pinned).toContainText("Thanks for watching!");
  // A timestamp in a comment seeks the player, like one in the description.
  await expect(pinned.getByRole("button", { name: "0:42" })).toBeVisible();

  const glue = threads.nth(1);
  await expect(glue).toContainText("120 likes");
  await expect(glue).toContainText("by the creator");
  await expect(glue).not.toContainText("Titebond III");
  await glue.getByRole("button", { name: "2 replies" }).click();
  await expect(
    glue.getByRole("button", { name: "Hide replies" })
  ).toHaveAttribute("aria-expanded", "true");
  await expect(glue).toContainText("Titebond III, clamped overnight.");
  await expect(glue).toContainText("Same here, works great.");

  // The saved comments come in steps; fewer than YouTube's first 100 means
  // there is nothing more to read from YouTube.
  await panel.getByRole("button", { name: "Show more comments" }).click();
  await expect(threads).toHaveCount(10);
  await expect(
    panel.getByRole("button", { name: "Show more comments" })
  ).toHaveCount(0);
});

test("a video without a YouTube id has no comments section", async ({
  page,
}) => {
  await page.goto(`/watch/${await videoId(page, "Aurora Drift")}`);
  await expect(
    page.getByRole("heading", { name: "Aurora Drift" })
  ).toBeVisible();
  await expect(page.locator("[data-horde='comments']")).toHaveCount(0);
});

test("library search finds a video through its saved comments", async ({
  page,
}) => {
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await (await openSearchBox(page)).fill("zeppelin");
  const card = videoCard(page, "Cedar Notes").first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Why this video matched" }).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "In a YouTube comment: “Thanks for watching! The zeppelin bit is at 0:42”"
  );
});

/** A top-level comment as the API returns it. */
function comment(id: string, text: string, replies: unknown[] = []) {
  return {
    id,
    author: `Author ${id}`,
    author_is_uploader: false,
    is_pinned: false,
    is_hearted: false,
    like_count: null,
    text,
    published_at: null,
    replies,
  };
}

test("more comments are read from YouTube, and a failed read keeps what is shown", async ({
  page,
}) => {
  const id = await videoId(page, "Cedar Notes");
  // As if all 100 top comments had been saved: YouTube has more.
  await page.route(new RegExp(`/api/videos/${id}/comments$`), async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), next_limit: 300 },
    });
  });
  let calls = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    /\/api\/comments\/youtube\/e2ecedar001\?limit=300$/,
    async (route: Route) => {
      calls += 1;
      if (calls === 1) {
        await held;
        return route.fulfill({
          status: 503,
          json: {
            detail: "Could not reach YouTube",
            code: "youtube_unreachable",
          },
        });
      }
      return route.fulfill({
        json: {
          status: "ok",
          total_count: 2400,
          // The first saved one again (skipped), then three new ones.
          items: [
            comment("c-pin", "Thanks for watching!"),
            comment("live-1", "Found this years later"),
            comment("live-2", "Still the best cedar video"),
            comment("live-3", "Part two when?"),
          ],
          next_limit: null,
        },
      });
    }
  );

  await page.goto(`/watch/${id}`);
  const panel = page.getByRole("region", { name: /Comments/ });
  const threads = panel.locator(":scope > ol > li");
  await panel.getByRole("button", { name: "Show more comments" }).click();
  await expect(threads).toHaveCount(10);

  await panel.getByRole("button", { name: "Show more comments" }).click();
  await expect(
    panel.getByRole("button", { name: "Loading from YouTube…" })
  ).toBeDisabled();
  release();
  await expect(panel.getByRole("status")).toHaveText(
    "Could not reach YouTube; try again later."
  );
  await expect(threads).toHaveCount(10);

  await panel.getByRole("button", { name: "Try again" }).click();
  await expect(threads).toHaveCount(13);
  await expect(threads.last()).toContainText("Part two when?");
  await expect(
    panel.getByRole("button", { name: /Show more|Try again/ })
  ).toHaveCount(0);
});

test("a streamed video loads its comments on request and keeps replies on the next step", async ({
  page,
}) => {
  const url = "https://www.youtube.com/watch?v=strm0000001";
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({
      json: {
        id: "strm0000001",
        title: "Streamed walk",
        channel: "Test Channel",
        channel_url: null,
        description: "",
        duration: 600,
        thumbnail_url: null,
        source_url: url,
        library_video_id: null,
        subtitles: [],
        available_presets: [],
        view_count: 10,
      },
    })
  );
  await page.route(/\/api\/preview\/(manifest|stream|subtitles)\?/, (route) =>
    route.fulfill({ status: 404, json: { detail: "no media", code: "x" } })
  );
  await page.route(/\/api\/preview\/related\?/, (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } })
  );
  const reply = { ...comment("t-1.a", "Agreed!"), replies: [] };
  await page.route(
    /\/api\/comments\/youtube\/strm0000001\?limit=100$/,
    (route) =>
      route.fulfill({
        json: {
          status: "ok",
          total_count: 900,
          items: [comment("t-1", "What a view", [reply])],
          next_limit: 300,
        },
      })
  );
  await page.route(
    /\/api\/comments\/youtube\/strm0000001\?limit=300$/,
    (route) =>
      route.fulfill({
        json: {
          status: "ok",
          total_count: 900,
          items: [comment("t-1", "What a view"), comment("t-2", "Lovely")],
          next_limit: null,
        },
      })
  );

  await page.goto(`/watch?url=${encodeURIComponent(url)}`);
  const panel = page.getByRole("region", { name: /Comments/ });
  await panel.getByRole("button", { name: "Load comments" }).click();
  const threads = panel.locator(":scope > ol > li");
  await expect(threads).toHaveCount(1);
  await panel.getByRole("button", { name: "Show more comments" }).click();
  await expect(threads).toHaveCount(2);
  // The longer list has no replies; the first read's stay with their thread.
  await threads.first().getByRole("button", { name: "1 reply" }).click();
  await expect(threads.first()).toContainText("Agreed!");
});

test("the refresh button fetches and saves the comments again", async ({
  page,
}) => {
  const id = await videoId(page, "Cedar Notes");
  const saved = await (
    await page.request.get(`/api/videos/${id}/comments`)
  ).json();
  let refreshed = 0;
  await page.route(
    new RegExp(`/api/videos/${id}/comments/refresh$`),
    async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-horde-request"]).toBeTruthy();
      refreshed += 1;
      await route.fulfill({
        json: {
          ...saved,
          total_count: 2500,
          items: [comment("fresh-1", "A new top comment"), ...saved.items],
        },
      });
    }
  );

  await page.goto(`/watch/${id}`);
  const panel = page.getByRole("region", { name: /Comments/ });
  const button = panel.getByRole("button", { name: "Refresh comments" });
  await expect(button).toHaveAttribute("title", /^Refresh comments \(saved /);
  await button.click();
  await expect(panel.locator(":scope > ol > li").first()).toContainText(
    "A new top comment"
  );
  await expect(panel.getByRole("heading")).toHaveText("Comments 2.5K");
  expect(refreshed).toBe(1);
});
