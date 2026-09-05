import { describe, expect, it } from "vitest";
import {
  maxPresetLabel,
  mergePinnedPreset,
  presetOptionLabel,
  resolveQualityPreset,
} from "./presets";

describe("presets", () => {
  it("labels with approximate size", () => {
    expect(presetOptionLabel("1080p", { "1080p": 1024 })).toContain("1080p");
    expect(presetOptionLabel("1080p", { "1080p": 1024 })).toContain("~");
  });

  it("merges pinned preset into order", () => {
    expect(mergePinnedPreset(["720p", "audio", "audio-128"], "1080p")).toEqual([
      "1080p",
      "720p",
      "audio",
      "audio-128",
    ]);
    expect(mergePinnedPreset(["720p"], "best")).toEqual(["720p"]);
  });

  it("labels audio bitrates", () => {
    expect(presetOptionLabel("audio", undefined)).toBe("Audio (best)");
    expect(presetOptionLabel("audio-128", undefined)).toBe("Audio · 128 kbps");
  });

  it("labels 4K and 1440p without extra parentheticals", () => {
    expect(presetOptionLabel("2160p", undefined)).toBe("4K");
    expect(presetOptionLabel("1440p", undefined)).toBe("1440p");
  });

  it("picks max preset label", () => {
    expect(maxPresetLabel(["720p", "1080p"])).toBe("1080p");
    expect(maxPresetLabel(["2160p"])).toBe("4K");
    expect(maxPresetLabel(["audio"])).toBe("Audio");
    expect(maxPresetLabel(["audio-64", "audio-128"])).toBe("Audio");
  });

  it("resolves best to the highest concrete tier", () => {
    expect(resolveQualityPreset("best", ["720p", "2160p", "1080p"])).toBe(
      "2160p"
    );
    expect(resolveQualityPreset("best", ["audio", "720p"])).toBe("720p");
    expect(resolveQualityPreset("best", ["audio"])).toBe("audio");
    expect(resolveQualityPreset("1080p", ["2160p", "1080p"])).toBe("1080p");
    expect(resolveQualityPreset("best", [])).toBe("best");
  });
});
