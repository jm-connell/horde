import { CSRF_HEADERS, expect, test } from "./fixtures";

const YT = "clipstr0001";
const STREAM_URL = `https://www.youtube.com/watch?v=${YT}`;
const WATCH = `/watch?url=${encodeURIComponent(STREAM_URL)}`;

test("a past stream can be saved as a clip from its ••• menu", async ({
  page,
}) => {
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({
      json: {
        id: YT,
        title: "Late night speedruns",
        channel: "Horde Live",
        channel_url: null,
        description: null,
        duration: 7200,
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
  // No yt-dlp in e2e: playback just fails to load.
  await page.route(/\/api\/preview\/(manifest|stream|subtitles)\?/, (route) =>
    route.fulfill({ status: 404, json: { detail: "no media", code: "x" } })
  );
  await page.goto(WATCH);
  await expect(
    page.getByRole("heading", { name: "Late night speedruns" })
  ).toBeVisible();

  await page.getByRole("button", { name: "More stream actions" }).click();
  await page.getByRole("menuitem", { name: "Save a clip…" }).click();
  const dialog = page.getByRole("dialog", { name: "Save a clip" });
  await dialog.getByLabel("Start").fill("1:00:00");
  await dialog.getByLabel("End").fill("1:02:30");
  await expect(dialog.getByText("Length 2:30")).toBeVisible();

  const queued = page.waitForResponse(
    (r) => r.url().endsWith("/api/downloads/clips") && r.ok()
  );
  await dialog.getByRole("button", { name: "Save clip" }).click();
  const job = await (await queued).json();
  try {
    expect(job).toMatchObject({
      clip_start_sec: 3600,
      clip_end_sec: 3750,
      title: "Late night speedruns (clip 1:00:00–1:02:30)",
    });
    await expect(page.getByText("Clip queued")).toBeVisible();
    await expect(dialog).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/downloads/${job.id}`, {
      headers: CSRF_HEADERS,
    });
  }
});

test("the clip dialog refuses an end before the start", async ({ page }) => {
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({
      json: {
        id: YT,
        title: "Late night speedruns",
        channel: "Horde Live",
        source_url: STREAM_URL,
        subtitles: [],
        available_presets: [],
        is_live: false,
        was_live: true,
      },
    })
  );
  await page.route(/\/api\/preview\/(manifest|stream|subtitles)\?/, (route) =>
    route.fulfill({ status: 404, json: { detail: "no media", code: "x" } })
  );
  await page.goto(WATCH);
  await page.getByRole("button", { name: "More stream actions" }).click();
  await page.getByRole("menuitem", { name: "Save a clip…" }).click();
  const dialog = page.getByRole("dialog", { name: "Save a clip" });
  // Typed key by key, and cleared on the way: the field keeps what is typed.
  const startField = dialog.getByLabel("Start");
  await startField.fill("");
  await expect(startField).toBeVisible();
  await expect(dialog.getByText("Enter times as h:mm:ss.")).toBeVisible();
  await startField.pressSequentially("5:00");
  await expect(startField).toHaveValue("5:00");
  await dialog.getByLabel("End").fill("4:00");
  await expect(
    dialog.getByText("The end has to come at least a second after the start.")
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save clip" })
  ).toBeDisabled();
});
