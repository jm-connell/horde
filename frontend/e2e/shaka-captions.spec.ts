import { expect, test } from "./fixtures";
import { H264_MEDIA } from "./stream-media";
import type { Page } from "@playwright/test";

/**
 * Real playback through Shaka: a stream preview plays with the DASH build and
 * a live broadcast with the HLS build. The overlay paints captions in the
 * normal player; Shaka's own (native) text track only shows while picture in
 * picture owns the pixels. A quality cut for dropped frames stays with
 * the stream it happened on.
 */
const MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
  profiles="urn:mpeg:dash:profile:isoff-live:2011"
  mediaPresentationDuration="PT6.0S" minBufferTime="PT2.0S">
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video" segmentAlignment="true">
      <Representation id="0" mimeType="video/mp4" codecs="avc1.42c00a"
        bandwidth="20000" width="160" height="90">
        <SegmentTemplate timescale="1000000" duration="2000000"
          initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const M3U8 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.0,
seg-1.m4s
#EXTINF:2.0,
seg-2.m4s
#EXTINF:2.0,
seg-3.m4s
#EXT-X-ENDLIST`;

const CUE = "Shaka caption line";
const VTT = `WEBVTT\n\n00:00:00.000 --> 00:00:06.000\n${CUE}\n`;

const STREAM_URL = "https://video.example.test/watch?v=abc123";
const META = {
  id: "abc123",
  title: "Ridge at dusk",
  channel: "Test Channel",
  channel_url: null,
  description: "",
  duration: 6,
  thumbnail_url: null,
  source_url: STREAM_URL,
  library_video_id: null,
  subtitles: [{ lang: "en", auto: false }],
  available_presets: [],
  view_count: 1,
};

async function mockStream(page: Page, live: boolean) {
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({ json: { ...META, is_live: live } })
  );
  await page.route(/\/api\/preview\/subtitles\?/, (route) =>
    route.fulfill({ contentType: "text/vtt", body: VTT })
  );
  await page.route(/\/api\/preview\/manifest\?/, (route) =>
    route.fulfill({ contentType: "application/dash+xml", body: MPD })
  );
  await page.route(/\/api\/live\/abc123\/master\.m3u8/, (route) =>
    route.fulfill({ contentType: "application/vnd.apple.mpegurl", body: M3U8 })
  );
  // Segment URLs resolve against the manifest: /api/preview/… or /api/live/abc123/….
  await page.route(/\/(init\.mp4|seg-\d\.m4s)$/, (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const body = H264_MEDIA[name];
    if (!body) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "video/mp4",
      body: Buffer.from(body, "base64"),
    });
  });
}

/** Mode and cue text of each text track on the player's <video>. */
function textTracks(page: Page) {
  return page
    .locator("video")
    .first()
    .evaluate((v: HTMLVideoElement) =>
      Array.from(v.textTracks).map((t) => ({
        mode: t.mode,
        cues: Array.from(t.cues ?? []).map((c) => (c as VTTCue).text),
      }))
    );
}

const showing = (page: Page) =>
  textTracks(page).then((tracks) =>
    tracks.filter((t) => t.mode === "showing").flatMap((t) => t.cues)
  );

/** Open the stream page and wait until Shaka has loaded the media. */
async function openStream(page: Page, live: boolean) {
  await mockStream(page, live);
  await page.goto(`/watch?url=${encodeURIComponent(STREAM_URL)}`);
  await expect(
    page.getByRole("heading", { name: "Ridge at dusk", level: 1 })
  ).toBeVisible();
  // The quality button lists Shaka's variant ladder, so it proves a load.
  await expect(page.getByRole("button", { name: "Auto · 144p" })).toBeVisible();
  // Paused, the control bar stays up.
  await page
    .locator("video")
    .first()
    .evaluate((v: HTMLVideoElement) => {
      v.pause();
      v.currentTime = 1;
    });
}

test("captions toggle through the Shaka DASH build", async ({ page }) => {
  await openStream(page, false);
  const cc = page.getByRole("button", { name: "CC (subtitles)" });
  const overlay = page.locator(".subtitle-overlay-visible");

  // On: the overlay paints the cue and Shaka's own text stays hidden.
  await cc.click();
  await expect(overlay).toHaveText(CUE);
  await expect.poll(() => showing(page)).toEqual([]);

  const fire = (type: string) =>
    page
      .locator("video")
      .first()
      .evaluate((v, t) => v.dispatchEvent(new Event(t)), type);
  // Picture in picture: Shaka shows the selected track natively.
  await fire("enterpictureinpicture");
  await expect.poll(() => showing(page)).toContain(CUE);
  await fire("leavepictureinpicture");
  await expect.poll(() => showing(page)).toEqual([]);

  // Off: nothing shows, even in picture in picture.
  await cc.click();
  await expect(overlay).toHaveCount(0);
  await fire("enterpictureinpicture");
  await page.waitForTimeout(300);
  expect(await showing(page)).toEqual([]);
});

test("a live broadcast plays through the Shaka HLS build", async ({ page }) => {
  await openStream(page, true);
  // Live broadcasts carry no subtitle tracks, so there is nothing to toggle.
  await expect(
    page.getByRole("button", { name: "CC (subtitles)" })
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("");
});

/** Pretend the page is hidden (screen off) or shown again. */
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    if (h) document.querySelector("video")?.pause(); // As iOS does on lock.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (h ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("a live stream left for a while reconnects and plays on", async ({
  page,
}) => {
  await page.clock.install();
  let loads = 0;
  page.on("request", (r) => {
    if (/\/api\/live\/abc123\/master\.m3u8/.test(r.url())) loads += 1;
  });
  await openStream(page, true);
  // The clip is 6 s long, so count the player's play() calls rather than
  // watching it play.
  const video = page.locator("video").first();
  await video.evaluate((v: HTMLVideoElement) => {
    const w = window as unknown as { __plays: number };
    w.__plays = 0;
    v.addEventListener("play", () => (w.__plays += 1));
  });
  const plays = () =>
    page.evaluate(() => (window as unknown as { __plays: number }).__plays);

  const before = loads;

  // Back after a few seconds: it just carries on.
  await setHidden(page, true);
  await page.clock.fastForward(5_000);
  await setHidden(page, false);
  await expect.poll(plays).toBe(1);
  expect(loads).toBe(before);

  // Back after minutes: the stream is loaded again and plays.
  await setHidden(page, true);
  await page.clock.fastForward("02:00");
  await setHidden(page, false);
  await expect.poll(() => loads).toBeGreaterThan(before);
  await expect.poll(plays).toBeGreaterThan(1);
});

test("on a phone captions are centred and sized to the player", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStream(page, false);
  await page.getByRole("button", { name: "CC (subtitles)" }).click();
  await expect(page.locator(".subtitle-overlay-visible")).toHaveText(CUE);

  const video = (await page.locator("video").first().boundingBox())!;
  const caption = (await page.locator(".subtitle-overlay").boundingBox())!;
  const centre = (b: { x: number; width: number }) => b.x + b.width / 2;
  expect(Math.abs(centre(caption) - centre(video))).toBeLessThan(2);
  const fontPx = await page
    .locator(".subtitle-overlay")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  // Medium on a 390 px wide picture: about 14 px, not the 20 px desktop floor.
  expect(fontPx).toBeLessThan(16);
});

/** Open the stream with `seg-2` failing: `failures` times, or always. */
async function openWithFailingSegment(page: Page, failures: number) {
  await mockStream(page, false);
  const seen = { manifests: 0, failed: 0 };
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      request.url().includes("/api/preview/manifest?")
    ) {
      seen.manifests += 1;
    }
  });
  await page.route(/\/seg-2\.m4s$/, (route) => {
    if (seen.failed >= failures) return route.fallback();
    seen.failed += 1;
    return route.fulfill({ status: 502, json: { detail: "upstream" } });
  });
  await page.goto(`/watch?url=${encodeURIComponent(STREAM_URL)}`);
  await expect(
    page.getByRole("heading", { name: "Ridge at dusk", level: 1 })
  ).toBeVisible();
  return seen;
}

test("a stream whose media requests fail is loaded again instead of dying", async ({
  page,
}) => {
  test.slow();
  // Shaka tries a segment five times before it reports the failure.
  const seen = await openWithFailingSegment(page, 5);
  // The stream is loaded again by itself and then plays through the segment.
  await expect.poll(() => seen.manifests, { timeout: 30_000 }).toBe(2);
  await expect
    .poll(
      () =>
        page
          .locator("video")
          .first()
          .evaluate((v: HTMLVideoElement) => v.currentTime),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(2.5);
  await expect(page.getByText(/Compatibility-mode preview failed/)).toHaveCount(
    0
  );
  await expect(page.getByText(/stopped loading/)).toHaveCount(0);
});

test("a stream that keeps failing says so, without a compatibility-mode detour", async ({
  page,
}) => {
  test.slow();
  const seen = await openWithFailingSegment(page, Infinity);
  await expect(
    page.getByText(
      "The stream stopped loading. Try again or download the video."
    )
  ).toBeVisible({ timeout: 60_000 });
  // Two reloads were tried first.
  expect(seen.manifests).toBe(3);
  await expect(page.getByText(/Compatibility-mode preview failed/)).toHaveCount(
    0
  );
});

/**
 * The same media declared as 1080p and 360p, so Shaka offers a two-step
 * ladder (it plays the 160x90 segments whatever the declared size).
 */
const LADDER_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
  profiles="urn:mpeg:dash:profile:isoff-live:2011"
  mediaPresentationDuration="PT6.0S" minBufferTime="PT2.0S">
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video" segmentAlignment="true"
      mimeType="video/mp4" codecs="avc1.42c00a">
      <SegmentTemplate timescale="1000000" duration="2000000"
        initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1"/>
      <Representation id="hd" bandwidth="40000" width="1920" height="1080"/>
      <Representation id="sd" bandwidth="20000" width="640" height="360"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test("a quality cut for dropped frames stays with its stream", async ({
  page,
}) => {
  test.slow();
  // The first stream's decoder drops half its frames while the window has
  // focus (a game on the other monitor still rendering); the next is fine.
  await page.addInitScript(() => {
    if (!location.search.includes("abc123")) return;
    const start = Date.now();
    HTMLVideoElement.prototype.getVideoPlaybackQuality = () => {
      const total = Math.round(((Date.now() - start) / 1000) * 30);
      return {
        totalVideoFrames: total,
        droppedVideoFrames: Math.round(total / 2),
        corruptedVideoFrames: 0,
        creationTime: performance.now(),
      } as VideoPlaybackQuality;
    };
    Document.prototype.hasFocus = () => true;
  });
  await mockStream(page, false);
  await page.route(/\/api\/preview\/manifest\?/, (route) =>
    route.fulfill({ contentType: "application/dash+xml", body: LADDER_MPD })
  );

  await page.goto(`/watch?url=${encodeURIComponent(STREAM_URL)}`);
  await expect(
    page.getByRole("button", { name: "Auto · 1080p" })
  ).toBeVisible();
  await expect(
    page.getByText("Reduced quality for smooth playback")
  ).toBeVisible({ timeout: 30_000 });

  // The next stream offers its whole ladder again, starting on Auto.
  const next = "https://video.example.test/watch?v=def456";
  await page.goto(`/watch?url=${encodeURIComponent(next)}`);
  await expect(
    page.getByRole("button", { name: "Auto · 1080p" })
  ).toBeVisible();
});

/**
 * A video whose 4K comes only in AV1 (served from av1/, though the bytes are
 * the same H.264 media) over a 1080p and 360p H.264 ladder.
 */
const MIXED_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
  profiles="urn:mpeg:dash:profile:isoff-live:2011"
  mediaPresentationDuration="PT6.0S" minBufferTime="PT2.0S">
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video" segmentAlignment="true"
      mimeType="video/mp4">
      <BaseURL>av1/</BaseURL>
      <SegmentTemplate timescale="1000000" duration="2000000"
        initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1"/>
      <Representation id="uhd" codecs="av01.0.12M.08" bandwidth="60000"
        width="3840" height="2160"/>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="video" segmentAlignment="true"
      mimeType="video/mp4" codecs="avc1.42c00a">
      <SegmentTemplate timescale="1000000" duration="2000000"
        initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1"/>
      <Representation id="hd" bandwidth="40000" width="1920" height="1080"/>
      <Representation id="sd" bandwidth="20000" width="640" height="360"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test("Auto skips AV1 decoded in software, and the menu still offers its 4K", async ({
  page,
}) => {
  // This browser decodes AV1, but only in software (not power efficient).
  await page.addInitScript(() => {
    const mc = navigator.mediaCapabilities;
    const real = mc.decodingInfo.bind(mc);
    mc.decodingInfo = async (config) => {
      const info = await real(config);
      return config.video?.contentType.includes("av01")
        ? { ...info, supported: true, powerEfficient: false }
        : info;
    };
  });
  const av1: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/av1/")) av1.push(r.url());
  });
  let manifests = 0;
  await mockStream(page, false);
  await page.route(/\/api\/preview\/manifest\?/, (route) => {
    manifests += 1;
    return route.fulfill({
      contentType: "application/dash+xml",
      body: MIXED_MPD,
    });
  });

  await page.goto(`/watch?url=${encodeURIComponent(STREAM_URL)}`);
  const quality = page.getByRole("button", { name: "Auto · 1080p" });
  await expect(quality).toBeVisible();
  expect(av1).toEqual([]);

  // Picking it loads this video again with its AV1 ladder.
  await quality.click();
  await page.getByRole("menuitemradio", { name: "4K" }).click();
  await expect.poll(() => manifests).toBe(2);
  await expect.poll(() => av1.length).toBeGreaterThan(0);
});
