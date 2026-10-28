import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { CSRF_HEADERS, expect, test } from "./fixtures";

const YT = "clipstr0001";
const STREAM_URL = `https://www.youtube.com/watch?v=${YT}`;
const WATCH = `/watch?url=${encodeURIComponent(STREAM_URL)}`;
// A real 20 s file from the seeded library stands in for the stream's media.
const MEDIA = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../e2e/.runtime/app/downloads/Northwind/2024/Aurora Drift.mp4"
);

async function mockPastStream(page: Page) {
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({
      json: {
        id: YT,
        title: "Late night speedruns",
        channel: "Horde Live",
        channel_url: null,
        description: null,
        duration: 20,
        thumbnail_url: null,
        source_url: STREAM_URL,
        library_video_id: null,
        subtitles: [],
        available_presets: [],
        view_count: 10,
        is_live: false,
        was_live: true,
      },
    })
  );
  await page.route(/\/api\/preview\/(manifest|subtitles)\?/, (route) =>
    route.fulfill({ status: 404, json: { detail: "no media", code: "x" } })
  );
  await page.route(/\/api\/preview\/stream\?/, (route) =>
    route.fulfill({ path: MEDIA, contentType: "video/mp4" })
  );
}

async function openClipPanel(page: Page) {
  await page.goto(WATCH);
  await expect(
    page.getByRole("heading", { name: "Late night speedruns" })
  ).toBeVisible();
  await page.getByRole("button", { name: "More stream actions" }).click();
  await page.getByRole("menuitem", { name: "Save a clip…" }).click();
  return page.getByRole("region", { name: "Save a clip" });
}

test("a past stream is clipped from the panel under the player", async ({
  page,
}) => {
  await mockPastStream(page);
  const panel = await openClipPanel(page);
  await expect(panel).toBeVisible();
  // The picker opens right under the video and the page is back at the top.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await panel.getByLabel("Start").fill("0:05");
  await panel.getByLabel("End").fill("0:12");
  await expect(panel.getByText("Length 0:07")).toBeVisible();
  // The picked range shows on the seek bar; playback is not moved to it.
  const marks = page.getByTestId("clip-range");
  await expect(marks).toBeAttached();
  await expect(marks.locator("span")).toHaveCount(3);

  const queued = page.waitForResponse(
    (r) => r.url().endsWith("/api/downloads/clips") && r.ok()
  );
  await panel.getByRole("button", { name: "Save clip" }).click();
  const job = await (await queued).json();
  try {
    expect(job).toMatchObject({
      clip_start_sec: 5,
      clip_end_sec: 12,
      title: "Late night speedruns (clip 0:05–0:12)",
    });
    await expect(page.getByText("Clip queued")).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId("clip-range")).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/downloads/${job.id}`, {
      headers: CSRF_HEADERS,
    });
  }
});

test("the clip panel keeps what is typed and refuses an end before the start", async ({
  page,
}) => {
  await mockPastStream(page);
  const panel = await openClipPanel(page);
  // Typed key by key, and cleared on the way: the field keeps what is typed.
  const startField = panel.getByLabel("Start");
  await startField.fill("");
  await expect(startField).toBeVisible();
  await expect(panel.getByText("Enter times as h:mm:ss.")).toBeVisible();
  await startField.pressSequentially("0:15");
  await expect(startField).toHaveValue("0:15");
  await panel.getByLabel("End").fill("0:10");
  await expect(
    panel.getByText("The end has to come at least a second after the start.")
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Save clip" })).toBeDisabled();
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toHaveCount(0);
});
