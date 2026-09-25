import type { Page } from "@playwright/test";
import { expect, test, videoCard } from "./fixtures";

async function waitForSettingsPatch(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.url().includes("/api/settings") &&
      response.request().method() === "PATCH" &&
      response.ok()
  );
}

async function mediaTime(page: Page): Promise<number> {
  return page
    .locator("video")
    .evaluate((el) => (el as HTMLVideoElement).currentTime);
}

async function seekableEnd(page: Page): Promise<number> {
  return page.locator("video").evaluate((el) => {
    const video = el as HTMLVideoElement;
    if (video.seekable.length < 1) return 0;
    return video.seekable.end(video.seekable.length - 1);
  });
}

/** Pause as soon as the file has a window long enough for a 5s seek. */
async function parkLiveVideo(page: Page) {
  await page.locator("video").evaluate(
    (el) =>
      new Promise<void>((resolve, reject) => {
        const video = el as HTMLVideoElement;
        const finish = () => {
          const span =
            video.seekable.length > 0
              ? video.seekable.end(video.seekable.length - 1) -
                video.seekable.start(0)
              : 0;
          if (span < 12) {
            reject(new Error(`DVR window is only ${span}s`));
            return;
          }
          video.pause();
          video.currentTime = Math.min(video.currentTime, 0.25);
          resolve();
        };
        if (video.readyState >= 1 && video.seekable.length > 0) finish();
        else video.addEventListener("loadedmetadata", finish, { once: true });
        video.addEventListener(
          "error",
          () => reject(new Error("live fixture failed to load")),
          { once: true }
        );
      })
  );
}

async function dragSeek(page: Page, ratio: number) {
  const bar = page.locator("[data-horde='seek']");
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  if (!box) throw new Error("seek bar has no box");
  const y = box.y + box.height / 2;
  // Press away from the 0:10 chapter marker, which sits near the middle.
  const from = box.x + box.width * 0.82;
  const x = box.x + Math.min(box.width - 2, Math.max(2, box.width * ratio));
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}

test("live bar stays hidden until the library setting is on", async ({
  page,
}) => {
  await page.goto("/");
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await expect(page.locator("[data-horde='live-channels']")).toHaveCount(0);

  await page.goto("/settings");
  await page.getByLabel("Search settings").fill("livestream");
  await expect(
    page.getByRole("heading", { name: "Livestreams" })
  ).toBeVisible();
  const toggle = page.getByRole("switch", { name: /Show live channels/ });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const saved = waitForSettingsPatch(page);
  await toggle.click();
  await saved;

  await page.goto("/");
  // Let the settings GET finish applying. A click during that merge is
  // overwritten by the server copy, which still has the row expanded.
  await page.waitForLoadState("networkidle");
  const bar = page.locator("[data-horde='live-channels']");
  await expect(bar).toBeVisible();
  const listing = await (await page.request.get("/api/channels/live")).json();
  const item = listing.items[0] as { channel: string; title: string; url: string };
  const bubble = page.getByRole("button", {
    name: `${item.channel}, live: ${item.title}`,
  });
  await expect(bubble).toBeVisible();

  const collapse = page.getByRole("button", { name: /^Live\s+1$/ });
  const collapsed = waitForSettingsPatch(page);
  await collapse.click();
  await collapsed;
  await expect(collapse).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(() =>
      page.locator("#live-channel-list").evaluate((el) => {
        const grid = el.parentElement?.parentElement;
        return grid ? getComputedStyle(grid).opacity : "";
      })
    )
    .toBe("0");

  await page.reload();
  await expect(bar).toBeVisible();
  await expect(collapse).toHaveAttribute("aria-expanded", "false");
  await collapse.click();
  await expect(bubble).toBeVisible();

  await bubble.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("url"))
    .toBe(item.url);
  await expect(
    page.getByRole("heading", { name: item.title, level: 1 })
  ).toBeVisible();
  await expect(page.getByText("Overnight on the ridge.")).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Livestreams are saved after they end.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /download/i })).toHaveCount(0);
  await expect(bubble).toHaveAttribute("aria-current", "true");
});

test("livestream player seeks with the timeline, arrows, chapters, and LIVE", async ({
  page,
  request,
}) => {
  const saved = await request.patch("/api/settings", {
    data: { ui: { show_live_channels: true } },
  });
  expect(saved.ok()).toBeTruthy();
  const listing = await (await request.get("/api/channels/live")).json();
  const item = listing.items[0] as { url: string; title: string };

  await page.goto(`/watch?url=${encodeURIComponent(item.url)}`);
  await expect(
    page.getByRole("heading", { name: item.title, level: 1 })
  ).toBeVisible();
  await parkLiveVideo(page);
  const end = await seekableEnd(page);
  expect(end).toBeGreaterThan(12);

  const before = await mediaTime(page);
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => mediaTime(page)).toBeGreaterThan(before + 4);
  const mid = await mediaTime(page);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => mediaTime(page)).toBeLessThan(mid - 4);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

  await dragSeek(page, 0.25);
  await expect.poll(() => mediaTime(page)).toBeGreaterThan(end * 0.12);
  await expect.poll(() => mediaTime(page)).toBeLessThan(end * 0.4);

  const chapter = page.getByRole("button", {
    name: "0:10 Ridge line",
    exact: true,
  });
  await expect(chapter).toBeVisible();
  const chapterSec = 10;
  await chapter.click();
  await expect.poll(() => mediaTime(page)).toBeGreaterThan(chapterSec - 0.6);
  await expect.poll(() => mediaTime(page)).toBeLessThan(chapterSec + 0.6);

  await page.locator("video").hover();
  await page.getByRole("button", { name: "LIVE", exact: true }).click();
  await expect.poll(() => mediaTime(page)).toBeGreaterThan(end - 2);

  await page.getByTitle("Playback speed").click();
  await page.getByRole("button", { name: "1.5x", exact: true }).click();
  await expect(page.locator("video")).toHaveJSProperty("playbackRate", 1.5);

  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unmute", exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "Theater", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Theater", exact: true })
  ).toHaveClass(/text-accent/);
});
