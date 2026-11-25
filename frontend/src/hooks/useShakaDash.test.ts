import { describe, expect, it } from "vitest";
import type {
  ShakaPlayer,
  ShakaVariantTrack,
} from "shaka-player/dist/shaka-player.dash.js";
import type { DecodeSupport } from "../utils/decodeCapability";
import {
  LIVE_MANIFEST_CONFIG,
  applyQualityPick,
  qualitiesInOtherCodecs,
  stateAfterDowngrade,
  stateAfterPick,
  selectQualityTrack,
  loadedCodecCeiling,
  streamLoadLimits,
  videoCodecConfig,
  freshStreamState,
  type CodecFamily,
  type StreamQualityState,
} from "./useShakaDash";

describe("live stream config", () => {
  it("appends live segments back to back (HLS sequence mode)", () => {
    // In segments mode Shaka pins each audio segment to its playlist start
    // (5.000 s apart) although YouTube's AAC segments run 4.992 or 5.016 s.
    // The few-ms gaps that leaves make Chrome's audio clock drift ahead of
    // the picture, about 1 s every 10 minutes, until a seek.
    expect(LIVE_MANIFEST_CONFIG.hls.sequenceMode).toBe(true);
  });

  it("keeps every codec of a live ladder (1440p and 2160p are VP9 only)", () => {
    // Preferring avc1 would make Shaka drop the VP9 variants.
    expect(videoCodecConfig(true, ["avc1"])).toEqual({});
    expect(videoCodecConfig(true, ["av01", "avc1"])).toEqual({});
  });

  it("prefers the given codecs in order for a video", () => {
    const codecs = (list: CodecFamily[]) =>
      videoCodecConfig(false, list).preferredVideo?.map((p) => p.codec);
    expect(codecs(["vp09", "avc1"])).toEqual(["vp09", "avc1"]);
    expect(codecs(["avc1"])).toEqual(["avc1"]);
  });
});

function fakePlayer(live: boolean) {
  const calls: [ShakaVariantTrack, boolean | undefined][] = [];
  const player = {
    isLive: () => live,
    selectVariantTrack: (track: ShakaVariantTrack, clearBuffer?: boolean) => {
      calls.push([track, clearBuffer]);
    },
  } as unknown as ShakaPlayer;
  return { player, calls };
}

describe("selectQualityTrack", () => {
  const track = { id: 7, height: 480 } as ShakaVariantTrack;

  it("clears the buffer on a video so the new quality shows at once", () => {
    const { player, calls } = fakePlayer(false);
    selectQualityTrack(player, track);
    expect(calls).toEqual([[track, true]]);
  });

  it("keeps the buffer on a live stream (sequence mode would misplace the new segments)", () => {
    const { player, calls } = fakePlayer(true);
    selectQualityTrack(player, track);
    expect(calls).toEqual([[track, false]]);
  });
});

describe("applyQualityPick", () => {
  it("lifts an automatic step-down's cap before choosing the track", () => {
    // Shaka leaves tracks over the restrictions out of getVariantTracks(),
    // so reading them under the cap made every pick above it land on it.
    let maxHeight = 480;
    const all = [2160, 1080, 480].map((height, id) => ({
      id,
      height,
      width: (height * 16) / 9,
      bandwidth: height * 1000,
      videoCodec: "avc1.64002A",
    })) as ShakaVariantTrack[];
    const picked: number[] = [];
    const player = {
      isLive: () => true,
      configure: (config: { restrictions?: { maxHeight?: number } }) => {
        if (config.restrictions?.maxHeight) {
          maxHeight = config.restrictions.maxHeight;
        }
      },
      getVariantTracks: () => all.filter((t) => (t.height ?? 0) <= maxHeight),
      selectVariantTrack: (t: ShakaVariantTrack) => picked.push(t.height ?? 0),
    } as unknown as ShakaPlayer;
    const { target, tracks } = applyQualityPick(player, 2160);
    expect(target).toBe(2160);
    expect(picked).toEqual([2160]);
    expect(tracks).toHaveLength(3);
  });
});

describe("applyQualityPick codec preference", () => {
  it("prefers VP9 then H.264 for a VP9 quality", () => {
    const track = {
      id: 1,
      height: 2160,
      width: 3840,
      bandwidth: 1,
      videoCodec: "vp09.00.50.08",
    } as ShakaVariantTrack;
    const configured: { preferredVideo?: { codec: string }[] }[] = [];
    const player = {
      isLive: () => false,
      configure: (c: { preferredVideo?: { codec: string }[] }) =>
        configured.push(c),
      getVariantTracks: () => [track],
      selectVariantTrack: () => undefined,
    } as unknown as ShakaPlayer;
    applyQualityPick(player, 2160);
    const pref = configured.find((c) => c.preferredVideo)?.preferredVideo;
    expect(pref?.map((p) => p.codec)).toEqual(["vp09", "avc1"]);
  });
});

describe("streamLoadLimits", () => {
  const caps = (av1: number, vp9: number): DecodeSupport => ({
    av1Supported: true,
    av1Efficient: av1 > 0,
    vp9Supported: true,
    maxSupportedHeight: 2160,
    maxAv1Efficient: av1,
    maxVp9Efficient: vp9,
  });
  const fresh = (): StreamQualityState => ({
    downgrade: null,
    pickedCodec: null,
    otherCodecQualities: [],
  });

  it.each([
    [2160, 2160, ["av01", "vp09", "avc1"], 2160],
    [2160, 0, ["av01", "avc1"], 2160],
    [0, 1440, ["vp09", "avc1"], 1440],
    [0, 0, ["avc1"], 1080],
  ])("av1 %i, vp9 %i plays %j up to %i", (av1, vp9, codecs, maxHeight) => {
    expect(streamLoadLimits(caps(av1, vp9), false, fresh())).toEqual({
      codecs,
      maxHeight,
    });
  });

  it("loads a picked codec first on any device, under its own limits", () => {
    const state: StreamQualityState = { ...fresh(), pickedCodec: "vp09" };
    expect(streamLoadLimits(caps(0, 0), false, state)).toEqual({
      codecs: ["vp09", "avc1"],
      maxHeight: 1080,
    });
  });

  it("leaves out a skipped codec, under the cut", () => {
    const state: StreamQualityState = {
      ...fresh(),
      downgrade: { maxHeight: 720, skipCodecs: ["vp09"] },
    };
    expect(streamLoadLimits(caps(0, 2160), false, state)).toEqual({
      codecs: ["avc1"],
      maxHeight: 720,
    });
  });

  it("reloads after an AV1 step-down without AV1, under the cut", () => {
    const state: StreamQualityState = {
      downgrade: { maxHeight: 1080, skipCodecs: ["av01"] },
      pickedCodec: "av01",
      otherCodecQualities: [],
    };
    expect(streamLoadLimits(caps(2160, 0), false, state)).toEqual({
      codecs: ["avc1"],
      maxHeight: 1080,
    });
  });

  it("takes a live stream above 1080p on Auto only where VP9 decodes in hardware", () => {
    expect(streamLoadLimits(caps(0, 0), true, fresh())).toEqual({
      codecs: [],
      maxHeight: 1080,
    });
    expect(streamLoadLimits(caps(2160, 2160), true, fresh())).toEqual({
      codecs: [],
      maxHeight: 2160,
    });
  });
});

describe("loadedCodecCeiling", () => {
  const caps = (maxSupportedHeight = 2160): DecodeSupport => ({
    av1Supported: true,
    av1Efficient: true,
    vp9Supported: true,
    maxSupportedHeight,
    maxAv1Efficient: 1440,
    maxVp9Efficient: 2160,
  });
  const state = (maxHeight?: number): StreamQualityState => ({
    downgrade: maxHeight ? { maxHeight, skipCodecs: [] } : null,
    pickedCodec: null,
    otherCodecQualities: [],
  });

  it("uses the hardware height of the codec that loaded", () => {
    expect(loadedCodecCeiling(caps(), "av01", state())).toBe(1440);
    expect(loadedCodecCeiling(caps(), "vp09", state())).toBe(2160);
    expect(loadedCodecCeiling(caps(), "avc1", state())).toBe(1080);
  });

  it("stays under the step-down and the device's supported height", () => {
    expect(loadedCodecCeiling(caps(), "vp09", state(720))).toBe(720);
    expect(loadedCodecCeiling(caps(1080), "vp09", state())).toBe(1080);
    expect(loadedCodecCeiling(caps(1080), "av01", state())).toBe(1080);
  });
});

describe("qualitiesInOtherCodecs", () => {
  const rep = (codecs: string, width: number, height: number) =>
    `<Representation id="${width}" bandwidth="1" codecs="${codecs}" width="${width}" height="${height}"><BaseURL>x</BaseURL></Representation>`;
  const mpd = (...sets: { mime?: string; reps: string[] }[]) =>
    `<?xml version="1.0"?><MPD><Period>${sets
      .map(
        ({ mime = "video/mp4", reps }, i) =>
          `<AdaptationSet id="${i}" contentType="video" mimeType="${mime}">${reps.join("")}</AdaptationSet>`
      )
      .join(
        ""
      )}<AdaptationSet id="9" contentType="audio"><Representation id="140" bandwidth="1" codecs="mp4a.40.2"/></AdaptationSet></Period></MPD>`;
  const caps = (over: Partial<DecodeSupport> = {}): DecodeSupport => ({
    av1Supported: true,
    av1Efficient: true,
    vp9Supported: true,
    maxSupportedHeight: 2160,
    maxAv1Efficient: 0,
    maxVp9Efficient: 0,
    ...over,
  });
  const av1 = [
    rep("av01.0.12M.08", 3840, 2160),
    rep("av01.0.12M.08", 2560, 1440),
    rep("av01.0.08M.08", 1920, 1080),
  ];
  const vp9 = [
    rep("vp09.00.50.08", 3840, 2160),
    rep("vp09.00.40.08", 2560, 1440),
  ];
  const avc = [rep("avc1.640028", 1920, 1080), rep("avc1.4d401f", 1280, 720)];
  const both = mpd(
    { reps: av1 },
    { mime: "video/webm", reps: vp9 },
    { reps: avc }
  );

  it("takes VP9 where it decodes in hardware", () => {
    expect(
      qualitiesInOtherCodecs(both, 1080, caps({ maxVp9Efficient: 2160 }))
    ).toEqual([
      { quality: 2160, codec: "vp09" },
      { quality: 1440, codec: "vp09" },
    ]);
  });

  it("takes AV1 where VP9 is not hardware decoded", () => {
    expect(qualitiesInOtherCodecs(both, 1080, caps())).toEqual([
      { quality: 2160, codec: "av01" },
      { quality: 1440, codec: "av01" },
    ]);
    expect(
      qualitiesInOtherCodecs(both, 1080, caps({ maxVp9Efficient: 1440 }))
    ).toEqual([
      { quality: 2160, codec: "av01" },
      { quality: 1440, codec: "vp09" },
    ]);
  });

  it("falls back to VP9 when AV1 is not supported", () => {
    expect(
      qualitiesInOtherCodecs(both, 1080, caps({ av1Supported: false }))
    ).toEqual([
      { quality: 2160, codec: "vp09" },
      { quality: 1440, codec: "vp09" },
    ]);
  });

  it("lists a VP9-only manifest's qualities as VP9", () => {
    expect(
      qualitiesInOtherCodecs(
        mpd({ mime: "video/webm", reps: vp9 }, { reps: avc }),
        1080,
        caps()
      )
    ).toEqual([
      { quality: 2160, codec: "vp09" },
      { quality: 1440, codec: "vp09" },
    ]);
  });

  it("lists nothing the browser cannot decode", () => {
    expect(
      qualitiesInOtherCodecs(
        both,
        1080,
        caps({ av1Supported: false, vp9Supported: false })
      )
    ).toEqual([]);
    expect(
      qualitiesInOtherCodecs(
        mpd({ mime: "video/webm", reps: vp9 }),
        1080,
        caps({ vp9Supported: false })
      )
    ).toEqual([]);
  });

  it("reads a portrait video's quality from its short side", () => {
    const text = mpd({ reps: [rep("av01.0.12M.08", 2160, 3840)] });
    expect(qualitiesInOtherCodecs(text, 1080, caps())).toEqual([
      { quality: 2160, codec: "av01" },
    ]);
  });

  it("takes the codec from the adaptation set when representations omit it", () => {
    const text = `<MPD><Period><AdaptationSet contentType="video" codecs="vp09.00.50.08"><Representation id="a" bandwidth="1" width="3840" height="2160"/></AdaptationSet></Period></MPD>`;
    expect(qualitiesInOtherCodecs(text, 1080, caps())).toEqual([
      { quality: 2160, codec: "vp09" },
    ]);
  });

  it("lists nothing when the other codecs go no higher", () => {
    const text = mpd({ reps: [av1[2]] }, { reps: avc });
    expect(qualitiesInOtherCodecs(text, 1080, caps())).toEqual([]);
  });
});

describe("stream state transitions", () => {
  const fresh = (): StreamQualityState => ({
    downgrade: null,
    pickedCodec: null,
    otherCodecQualities: [{ quality: 2160, codec: "vp09" }],
  });

  it("picking a quality only another codec has loads that codec", () => {
    const next = stateAfterPick(fresh(), 2160);
    expect(next).toEqual({
      downgrade: null,
      pickedCodec: "vp09",
      otherCodecQualities: [],
    });
  });

  it("picking a quality the loaded ladder has changes nothing here", () => {
    expect(stateAfterPick(fresh(), 1080)).toBeNull();
    expect(stateAfterPick(fresh(), "auto")).toBeNull();
  });

  it("picking Auto after a pick clears the picked codec", () => {
    const state: StreamQualityState = { ...fresh(), pickedCodec: "vp09" };
    expect(stateAfterPick(state, "auto")).toEqual({
      ...state,
      pickedCodec: null,
    });
  });

  it("a step-down on VP9 skips VP9 for the rest of the video", () => {
    const next = stateAfterDowngrade(fresh(), 1440, "vp09");
    expect(next.downgrade).toEqual({ maxHeight: 1440, skipCodecs: ["vp09"] });
    const caps: DecodeSupport = {
      av1Supported: true,
      av1Efficient: true,
      vp9Supported: true,
      maxSupportedHeight: 2160,
      maxAv1Efficient: 0,
      maxVp9Efficient: 2160,
    };
    expect(streamLoadLimits(caps, false, next).codecs).toEqual(["avc1"]);
    // Another video starts clean.
    expect(streamLoadLimits(caps, false, freshStreamState()).codecs).toEqual([
      "vp09",
      "avc1",
    ]);
  });

  it("steps keep earlier skips, lower heights and add no duplicates", () => {
    const first = stateAfterDowngrade(fresh(), 1440, "av01");
    const second = stateAfterDowngrade(first, 1080, "vp09");
    const third = stateAfterDowngrade(second, 1080, "vp09");
    expect(third.downgrade).toEqual({
      maxHeight: 1080,
      skipCodecs: ["av01", "vp09"],
    });
  });

  it("a step-down on H.264 skips no codec", () => {
    const next = stateAfterDowngrade(fresh(), 720, null);
    expect(next.downgrade).toEqual({ maxHeight: 720, skipCodecs: [] });
  });
});
