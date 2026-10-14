import { afterEach, describe, expect, it, vi } from "vitest";
import type { Video } from "../types";
import {
  _resetSupportCache,
  checkOriginalSupport,
  chooseRendition,
  codecLabel,
  estimateCompatBytes,
} from "./playbackRendition";
import { normalizeDownloadVideoCodec } from "../hooks/useSettings";

function video(extra: Partial<Video> = {}): Video {
  return {
    id: 1,
    file_path: "Chan/2024/Title [abcdefghijk].mp4",
    width_px: 3840,
    height_px: 2160,
    frame_rate: 30,
    file_size: 500_000_000,
    duration_sec: 600,
    codec_string: "av01.0.12M.08",
    vcodec: "av1",
    ...extra,
  } as Video;
}

function mockDecoding(result: { supported: boolean; smooth: boolean }) {
  const decodingInfo = vi.fn().mockResolvedValue({ ...result, powerEfficient: false });
  vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo } });
  return decodingInfo;
}

afterEach(() => {
  vi.unstubAllGlobals();
  _resetSupportCache();
});

describe("chooseRendition", () => {
  it("plays the original when it decodes smoothly", () => {
    expect(chooseRendition("smooth", { has_compat: true })).toEqual({ rendition: "original" });
  });
  it("uses the sidecar when the device cannot decode the original", () => {
    expect(chooseRendition("unsupported", { has_compat: true })).toEqual({ rendition: "compat" });
    expect(chooseRendition("unsupported", { has_compat: false })).toEqual({ rendition: null });
  });
  it("prefers smooth 1080p H.264 over a stuttering original", () => {
    expect(chooseRendition("rough", { has_compat: true })).toEqual({ rendition: "compat" });
    expect(chooseRendition("rough", { has_compat: false })).toEqual({ rendition: "original" });
  });
  it("honours try-anyway and unknown support", () => {
    expect(chooseRendition("unsupported", { has_compat: false }, { forceOriginal: true })).toEqual({
      rendition: "original",
    });
    expect(chooseRendition("unknown", { has_compat: false })).toEqual({ rendition: "original" });
  });
});

describe("checkOriginalSupport", () => {
  it("asks MediaCapabilities with the stored codec string", async () => {
    const decodingInfo = mockDecoding({ supported: false, smooth: false });
    expect(await checkOriginalSupport(video())).toBe("unsupported");
    const arg = decodingInfo.mock.calls[0][0];
    expect(arg.type).toBe("file");
    expect(arg.video.contentType).toBe('video/mp4; codecs="av01.0.12M.08"');
    expect(arg.video.width).toBe(3840);
    expect(arg.video.bitrate).toBe(Math.round((500_000_000 * 8) / 600));
  });
  it("maps supported-but-not-smooth to rough and caches", async () => {
    const decodingInfo = mockDecoding({ supported: true, smooth: false });
    expect(await checkOriginalSupport(video())).toBe("rough");
    expect(await checkOriginalSupport(video())).toBe("rough");
    expect(decodingInfo).toHaveBeenCalledTimes(1);
  });
  it("uses video/webm for webm/mkv and unknown without a codec string", async () => {
    const decodingInfo = mockDecoding({ supported: true, smooth: true });
    await checkOriginalSupport(video({ file_path: "a.mkv", codec_string: "vp09.00.40.08" }));
    expect(decodingInfo.mock.calls[0][0].video.contentType).toBe('video/webm; codecs="vp09.00.40.08"');
    expect(await checkOriginalSupport(video({ codec_string: null }))).toBe("unknown");
  });
});

describe("helpers", () => {
  it("labels codecs for people", () => {
    expect(codecLabel(video())).toBe("AV1");
    expect(codecLabel(video({ vcodec: "h264", bit_depth: 10 }))).toBe("10-bit H.264");
    expect(codecLabel(video({ vcodec: "h264", bit_depth: 8 }))).toBe("4K H.264");
  });
  it("estimates sidecar size like the server", () => {
    // 600 s × (5 Mbps + 160 kbps) / 8
    expect(estimateCompatBytes(video())).toBe(387_000_000);
  });
  it("normalizes modes and migrates legacy codec values", () => {
    expect(normalizeDownloadVideoCodec("sidecar")).toBe("sidecar");
    expect(normalizeDownloadVideoCodec("h264_native")).toBe("h264_native");
    expect(normalizeDownloadVideoCodec("h264")).toBe("h264_convert");
    expect(normalizeDownloadVideoCodec("h265")).toBe("h264_convert");
    expect(normalizeDownloadVideoCodec(undefined)).toBe("av1");
  });
});
