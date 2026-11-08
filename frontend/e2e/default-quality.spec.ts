import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Give this page's account a default download quality without saving it on
 * the server, so specs running in parallel as the same account never see it.
 */
async function withDefaultQuality(page: Page, preset: string) {
  await page.route(/\/api\/settings$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    json.ui = { ...(json.ui ?? {}), default_download_preset: preset };
    return route.fulfill({ response, json });
  });
}

/** Link previews by URL; presets are listed best first, as the server does. */
async function stubPreviews(page: Page, presets: Record<string, string[]>) {
  await page.route(/\/api\/downloads\/preview\?/, (route) => {
    const url = new URL(route.request().url()).searchParams.get("url") ?? "";
    const available = presets[url];
    if (!available) return route.continue();
    return route.fulfill({
      json: {
        is_playlist: false,
        title: `Preview of ${url}`,
        channel: "Northwind",
        channel_url: null,
        thumbnail_url: null,
        entry_count: 1,
        view_count: 1,
        published_at: null,
        available_presets: available,
        preset_sizes: {},
      },
    });
  });
}

test("the Download page maps the default quality onto each link", async ({
  page,
}) => {
  const video = "https://example.invalid/watch?v=tallclip";
  const podcast = "https://example.invalid/episode/42";
  await withDefaultQuality(page, "1440p");
  await stubPreviews(page, {
    [video]: ["2160p", "1080p", "720p", "audio"],
    [podcast]: ["audio", "audio-128"],
  });
  await page.goto("/download");
  const quality = page.getByRole("button", { name: "Quality" });
  const field = page.getByPlaceholder("Video or playlist URL (YouTube, etc.)");
  // Before a link is read, the default itself is selected.
  await expect(quality).toContainText("1440p");

  // A cap the video lacks becomes its best tier under the cap.
  await field.fill(video);
  await expect(page.getByPlaceholder("Auto-detected").first()).toHaveValue(
    `Preview of ${video}`
  );
  await expect(quality).toContainText("1080p");

  // An audio-only link gets audio, never a height cap it cannot satisfy.
  await field.fill(podcast);
  await expect(page.getByPlaceholder("Auto-detected").first()).toHaveValue(
    `Preview of ${podcast}`
  );
  await expect(quality).toContainText("Audio (best)");
});

test("downloading a video you are watching starts at the default quality", async ({
  page,
}) => {
  const stream = "https://video.example.test/watch?v=dq0001";
  await withDefaultQuality(page, "720p");
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({
      json: {
        id: "dq0001",
        title: "Default quality stream",
        channel: "Test Channel",
        channel_url: null,
        description: "",
        duration: 600,
        thumbnail_url: null,
        source_url: stream,
        library_video_id: null,
        subtitles: [],
        available_presets: ["1080p", "720p", "480p", "audio"],
        view_count: 1,
      },
    })
  );
  // No yt-dlp in e2e: playback just fails to load.
  await page.route(/\/api\/preview\/(manifest|stream|subtitles)\?/, (route) =>
    route.fulfill({ status: 404, json: { detail: "no media", code: "x" } })
  );
  await stubPreviews(page, { [stream]: ["1080p", "720p", "480p", "audio"] });
  await page.goto(
    `/watch?url=${encodeURIComponent(stream)}&channel=Test%20Channel`
  );
  await expect(
    page.getByRole("heading", { name: "Default quality stream", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download 720p" })
  ).toBeVisible();
});

test("a playlist subscription starts at the default quality", async ({
  page,
}) => {
  await withDefaultQuality(page, "720p");
  await page.goto("/playlists");
  await expect(
    page.getByRole("button", { name: "Max resolution" })
  ).toContainText("720p");
});
