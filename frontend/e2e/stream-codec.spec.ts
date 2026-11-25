import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  H264_MEDIA,
  VP9_INDEX_RANGE,
  VP9_INIT_RANGE,
  VP9_WEBM,
} from "./stream-media";

/**
 * A stream chooses its codec by what the device decodes in hardware. The
 * manifest is what the server builds for a video above 1080p: an H.264 set to
 * 1080p and a WebM (VP9) set to 4K. The H.264 set plays the tiny H.264 clip
 * and the VP9 set a tiny real WebM, both declared at their ladder sizes, so
 * the codec that loads is the codec whose media is requested. Which one
 * Shaka picked is read from those requests and from the quality button, since
 * the player is not exposed to the page.
 */
const MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
  profiles="urn:mpeg:dash:profile:isoff-live:2011"
  mediaPresentationDuration="PT6.0S" minBufferTime="PT2.0S">
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video" segmentAlignment="true"
      mimeType="video/webm">
      <Representation id="uhd" codecs="vp09.00.51.08" bandwidth="60000"
        width="3840" height="2160">
        <BaseURL>clip.webm</BaseURL>
        <SegmentBase indexRange="${VP9_INDEX_RANGE}" indexRangeExact="true">
          <Initialization range="${VP9_INIT_RANGE}"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="video" segmentAlignment="true"
      mimeType="video/mp4" codecs="avc1.42c00a">
      <SegmentTemplate timescale="1000000" duration="2000000"
        initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1"/>
      <Representation id="hd" bandwidth="40000" width="1920" height="1080"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const STREAM_URL = "https://video.example.test/watch?v=vp9tier01";
const META = {
  id: "vp9tier01",
  title: "Ridge at dusk in 4K",
  channel: "Test Channel",
  channel_url: null,
  description: "",
  duration: 6,
  thumbnail_url: null,
  source_url: STREAM_URL,
  library_video_id: null,
  subtitles: [],
  available_presets: [],
  view_count: 1,
  is_live: false,
};

/** Report what this device decodes: VP9 supported, hardware or software. */
async function stubDecoding(page: Page, vp9Hardware: boolean) {
  await page.addInitScript((hardware: boolean) => {
    // Drop the cached probe so the stub below is read.
    localStorage.removeItem("horde.decode-capability.v4");
    const mc = navigator.mediaCapabilities;
    const real = mc.decodingInfo.bind(mc);
    mc.decodingInfo = async (config) => {
      const type = config.video?.contentType ?? "";
      if (type.includes("vp09")) {
        return {
          ...(await real(config)),
          supported: true,
          powerEfficient: hardware,
        };
      }
      if (type.includes("av01")) {
        return {
          ...(await real(config)),
          supported: false,
          powerEfficient: false,
        };
      }
      return real(config);
    };
  }, vp9Hardware);
}

/** Serve the manifest and the media; return the media files asked for. */
async function serveStream(page: Page) {
  const asked = { webm: 0, mp4: 0 };
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({ json: META })
  );
  await page.route(/\/api\/preview\/manifest\?/, (route) =>
    route.fulfill({ contentType: "application/dash+xml", body: MPD })
  );
  await page.route(/\/(init\.mp4|seg-\d\.m4s)$/, (route) => {
    asked.mp4 += 1;
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const body = H264_MEDIA[name];
    if (!body) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "video/mp4",
      body: Buffer.from(body, "base64"),
    });
  });
  // The server proxies a WebM with byte ranges; Shaka asks for the init and
  // index ranges, then for each segment.
  await page.route(/\/clip\.webm$/, (route) => {
    asked.webm += 1;
    const range = /bytes=(\d+)-(\d+)?/.exec(
      route.request().headers()["range"] ?? ""
    );
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(Number(range[2]), VP9_WEBM.length - 1)
      : VP9_WEBM.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: "video/webm",
      headers: {
        "Content-Range": `bytes ${start}-${end}/${VP9_WEBM.length}`,
        "Accept-Ranges": "bytes",
      },
      body: VP9_WEBM.subarray(start, end + 1),
    });
  });
  return asked;
}

const open = (page: Page) =>
  page.goto(`/watch?url=${encodeURIComponent(STREAM_URL)}`);

test("a device with hardware VP9 plays the 4K WebM on Auto", async ({
  page,
}) => {
  await stubDecoding(page, true);
  const asked = await serveStream(page);
  await open(page);

  // Auto reaches 4K, and only the VP9 ladder is on offer (H.264's 1080p was
  // dropped when Shaka chose the codec).
  await expect(page.getByRole("button", { name: "Auto · 4K" })).toBeVisible();
  await expect.poll(() => asked.webm).toBeGreaterThan(0);
  expect(asked.mp4).toBe(0);
  await expect(page.getByRole("alert")).toHaveText("");

  await page.getByRole("button", { name: "Auto · 4K" }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "4K", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("menuitemradio", { name: "1080p", exact: true })
  ).toHaveCount(0);
});

test("a device without hardware VP9 plays H.264 on Auto, lists 4K, and loads the WebM when it is picked", async ({
  page,
}) => {
  await stubDecoding(page, false);
  const asked = await serveStream(page);
  await open(page);

  const auto = page.getByRole("button", { name: "Auto · 1080p" });
  await expect(auto).toBeVisible();
  await expect.poll(() => asked.mp4).toBeGreaterThan(0);
  expect(asked.webm).toBe(0);

  // 4K is in the menu though Auto stays below it; picking it loads the stream
  // again with the VP9 ladder.
  await auto.click();
  await page.getByRole("menuitemradio", { name: "4K", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "4K", exact: true })
  ).toBeVisible();
  await expect.poll(() => asked.webm).toBeGreaterThan(0);
  await expect(page.getByRole("alert")).toHaveText("");

  // Auto goes back to H.264.
  await page.getByRole("button", { name: "4K", exact: true }).click();
  const requestsBefore = asked.mp4;
  await page.getByRole("menuitemradio", { name: "Auto", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Auto · 1080p" })
  ).toBeVisible();
  await expect.poll(() => asked.mp4).toBeGreaterThan(requestsBefore);
});
