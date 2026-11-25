import { describe, expect, it } from "vitest";
import type {
  ShakaPlayer,
  ShakaVariantTrack,
} from "shaka-player/dist/shaka-player.dash.js";
import type { DecodeSupport } from "../utils/decodeCapability";
import {
  LIVE_MANIFEST_CONFIG,
  applyQualityPick,
  qualitiesOnlyInAv1,
  selectQualityTrack,
  streamLoadLimits,
  videoCodecConfig,
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

describe("qualitiesOnlyInAv1", () => {
  const rep = (codecs: string, width: number, height: number) =>
    `<Representation id="${width}" bandwidth="1" codecs="${codecs}" width="${width}" height="${height}"><BaseURL>x</BaseURL></Representation>`;
  const mpd = (...sets: string[][]) =>
    `<?xml version="1.0"?><MPD><Period>${sets
      .map(
        (reps, i) =>
          `<AdaptationSet id="${i}" contentType="video" mimeType="video/mp4">${reps.join("")}</AdaptationSet>`
      )
      .join(
        ""
      )}<AdaptationSet id="9" contentType="audio"><Representation id="140" bandwidth="1" codecs="mp4a.40.2"/></AdaptationSet></Period></MPD>`;

  it("lists the AV1 qualities above the H.264 ladder", () => {
    const text = mpd(
      [
        rep("av01.0.12M.08", 3840, 2160),
        rep("av01.0.12M.08", 2560, 1440),
        rep("av01.0.08M.08", 1920, 1080),
      ],
      [rep("avc1.640028", 1920, 1080), rep("avc1.4d401f", 1280, 720)]
    );
    expect(qualitiesOnlyInAv1(text, 1080)).toEqual([2160, 1440]);
  });

  it("reads a portrait video's quality from its short side", () => {
    const text = mpd([rep("av01.0.12M.08", 2160, 3840)], []);
    expect(qualitiesOnlyInAv1(text, 1080)).toEqual([2160]);
  });

  it("takes the codec from the adaptation set when representations omit it", () => {
    const text = `<MPD><Period><AdaptationSet contentType="video" codecs="av01.0.12M.08"><Representation id="a" bandwidth="1" width="3840" height="2160"/></AdaptationSet></Period></MPD>`;
    expect(qualitiesOnlyInAv1(text, 1080)).toEqual([2160]);
  });

  it("lists nothing when AV1 goes no higher", () => {
    const text = mpd([rep("av01.0.08M.08", 1920, 1080)], []);
    expect(qualitiesOnlyInAv1(text, 1080)).toEqual([]);
  });
});
