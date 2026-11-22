import fs from "node:fs";
import path from "node:path";
import { expect, test, videoCard } from "./fixtures";
import { appDownloads } from "./runtime";

// page.route cannot intercept <video> media requests, so these specs change the
// seeded file on disk (e2e/serve.py's downloads dir) and restore it afterwards.
const file = path.join(appDownloads, "Northwind/2024/Paper Kites.mp4");
let original: Buffer;

test.beforeEach(() => {
  original = fs.readFileSync(file);
});

test.afterEach(() => {
  fs.writeFileSync(file, original);
});

// The seeded videos have no recorded codec, so a failing original is a candidate
// for the "couldn't play" compat gate. Only a file the server serves may be
// blamed on the device.
test("a missing original shows a playback error, not the compat gate", async ({
  page,
}) => {
  fs.rmSync(file);
  await page.goto("/");
  await videoCard(page, "Paper Kites").first().click();
  await expect(page.getByText("This video could not be played")).toBeVisible();
  await expect(page.getByText(/This device couldn.t play/)).toHaveCount(0);
});

test("an original the browser cannot decode shows the compat gate", async ({
  page,
}) => {
  fs.writeFileSync(file, Buffer.alloc(4096, 7));
  await page.goto("/");
  await videoCard(page, "Paper Kites").first().click();
  await expect(page.getByText(/This device couldn.t play/)).toBeVisible();
  await expect(page.getByText("This video could not be played")).toHaveCount(0);
});

// A phone can lose its decoder for a moment (a call, the app in the background)
// part-way through a file it was playing fine. That says nothing about the codec.
test("a decode error after the original has played reloads it at the playhead", async ({
  page,
}) => {
  await page.goto("/");
  await videoCard(page, "Paper Kites").first().click();
  const video = page.locator("video").first();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.duration))
    .toBeGreaterThan(16);
  await video.evaluate((v: HTMLVideoElement) => {
    v.pause();
    v.currentTime = 8;
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBe(8);

  await video.evaluate((v: HTMLVideoElement) => {
    v.addEventListener("loadedmetadata", () => (v.dataset.reloaded = "1"), {
      once: true,
    });
    Object.defineProperty(v, "error", {
      configurable: true,
      get: () => ({ code: MediaError.MEDIA_ERR_DECODE }),
    });
    v.dispatchEvent(new Event("error"));
    delete (v as { error?: unknown }).error;
  });

  await expect(video).toHaveAttribute("data-reloaded", "1");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThanOrEqual(8);
  await expect(page.getByText(/This device couldn.t play/)).toHaveCount(0);
  await expect(page.getByText("This video could not be played")).toHaveCount(0);
});
