import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Real playback through Shaka: a stream preview plays with the DASH build and
 * a live broadcast with the HLS build. The overlay paints captions in the
 * normal player; Shaka's own (native) text track only shows while picture in
 * picture owns the pixels.
 *
 * Media: 6 s of 160x90 H.264 in three 2 s fMP4 segments, made with
 *   ffmpeg -f lavfi -i color=c=0x1a2540:s=160x90:r=5:d=6 -c:v libx264 \
 *     -profile:v baseline -pix_fmt yuv420p -g 10 -keyint_min 10 \
 *     -sc_threshold 0 -b:v 20k -f dash -seg_duration 2 -use_template 1 \
 *     -use_timeline 0 -init_seg_name init.mp4 \
 *     -media_seg_name 'seg-$Number$.m4s' manifest.mpd
 */
const MEDIA: Record<string, string> = {
  "init.mp4":
    "AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAx9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACInRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAoAAAAFoAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAAAAAAAAAAEAAAAAAZptZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAACgAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAFFbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABBXN0YmwAAAC5c3RzZAAAAAAAAAABAAAAqWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAoABaAEgAAABIAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAAAvYXZjQwFCwAr/4QAYZ0LACtkCjfkwEQAAAwABAAADAAoPEiZIAQAEaMuMsgAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAE4gAABOIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4xMDI=",
  "seg-1.m4s":
    "AAAAGHN0eXBtc2RoAAAAAG1zZGhtc2l4AAAANHNpZHgBAAAAAAAAAQAAKAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAA7kAAFAAgAAAAAAAAJBtb29mAAAAEG1maGQAAAAAAAAAAQAAAHh0cmFmAAAAHHRmaGQAAgA4AAAAAQAACAAAAALGAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAQHRydW4AAAIFAAAACgAAAJgCAAAAAAACxgAAAAoAAAALAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAyltZGF0AAACfAYF//943EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MToweDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTMgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MTAga2V5aW50X21pbj02IHNjZW5lY3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0xMCByYz1hYnIgbWJ0cmVlPTEgYml0cmF0ZT0yMCByYXRldG9sPTEuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAEJliIQN8RigACcDHAAEDiOAAIB8nJycnJycnJyddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAAGQZo4HeD2AAAAB0GaVAf4PYAAAAAGQZpgFfB7AAAABkGagBnwewAAAAZBmqAa8HsAAAAGQZrAGvB7AAAABkGa4BrwewAAAAZBmwAa8HsAAAAGQZsgGvB7",
  "seg-2.m4s":
    "AAAAGHN0eXBtc2RoAAAAAG1zZGhtc2l4AAAANHNpZHgBAAAAAAAAAQAAKAAAAAAAAABQAAAAAAAAAAAAAAAAAQAAAToAAFAAgAAAAAAAAJBtb29mAAAAEG1maGQAAAAAAAAAAgAAAHh0cmFmAAAAHHRmaGQAAgA4AAAAAQAACAAAAABGAQEAAAAAABR0ZmR0AQAAAAAAAAAAAFAAAAAAQHRydW4AAAIFAAAACgAAAJgCAAAAAAAARgAAAAsAAAALAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAKptZGF0AAAAQmWIggGvEYoAA/vxwABEejgACEPJycnJycnJycnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXgAAAAdBmjgNeD2AAAAAB0GaVANeD2AAAAAGQZpgGvB7AAAABkGagBrwewAAAAZBmqAa8HsAAAAGQZrAGvB7AAAABkGa4BrwewAAAAZBmwAa8HsAAAAGQZsgGvB7",
  "seg-3.m4s":
    "AAAAGHN0eXBtc2RoAAAAAG1zZGhtc2l4AAAANHNpZHgBAAAAAAAAAQAAKAAAAAAAAACgAAAAAAAAAAAAAAAAAQAAAToAAFAAgAAAAAAAAJBtb29mAAAAEG1maGQAAAAAAAAAAwAAAHh0cmFmAAAAHHRmaGQAAgA4AAAAAQAACAAAAABGAQEAAAAAABR0ZmR0AQAAAAAAAAAAAKAAAAAAQHRydW4AAAIFAAAACgAAAJgCAAAAAAAARgAAAAsAAAALAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAKptZGF0AAAAQmWIhAa8RigAD+/HAAER6OAAIQ8nJycnJycnJyddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAAdBmjgNeD2AAAAAB0GaVANeD2AAAAAGQZpgGvB7AAAABkGagBrwewAAAAZBmqAa8HsAAAAGQZrAGvB7AAAABkGa4BrwewAAAAZBmwAa8HsAAAAGQZsgGvB7",
};

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
    const body = MEDIA[name];
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
