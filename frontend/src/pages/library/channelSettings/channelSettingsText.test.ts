import { describe, expect, it } from "vitest";
import {
  autodownloadChipLabel,
  channelHandle,
  parseLimit,
  retentionChipLabel,
  retentionPreviewLine,
} from "./channelSettingsText";

describe("autodownloadChipLabel", () => {
  it("is null while auto-download is off", () => {
    expect(autodownloadChipLabel(null)).toBeNull();
    expect(
      autodownloadChipLabel({ enabled: false, quality_preset: "1080p" })
    ).toBeNull();
  });

  it("names the quality preset", () => {
    expect(
      autodownloadChipLabel({ enabled: true, quality_preset: "1080p" })
    ).toBe("Auto-download on · 1080p");
    expect(
      autodownloadChipLabel({ enabled: true, quality_preset: "2160p" })
    ).toBe("Auto-download on · 4K");
  });
});

describe("retentionChipLabel", () => {
  it("is null without a limit", () => {
    expect(retentionChipLabel(null)).toBeNull();
    expect(
      retentionChipLabel({
        keep_latest: null,
        max_age_days: null,
        remove_watched_after_days: null,
      })
    ).toBeNull();
  });

  it("lists every limit that is set", () => {
    expect(retentionChipLabel({ keep_latest: 20 })).toBe("Keeps latest 20");
    expect(
      retentionChipLabel({
        keep_latest: 20,
        max_age_days: 1,
        remove_watched_after_days: 7,
      })
    ).toBe(
      "Keeps latest 20 · Removes after 1 day · Removes watched after 7 days"
    );
  });
});

describe("retentionPreviewLine", () => {
  it("says when nothing would go", () => {
    expect(retentionPreviewLine({ count: 0, total_bytes: 0 })).toBe(
      "Right now this would move nothing to the trash."
    );
  });

  it("gives the count and size", () => {
    expect(
      retentionPreviewLine({ count: 12, total_bytes: 4.3 * 1024 ** 3 })
    ).toBe("Right now this would move 12 videos (4.3 GB) to the trash.");
    expect(retentionPreviewLine({ count: 1, total_bytes: 0 })).toBe(
      "Right now this would move 1 video to the trash."
    );
  });
});

describe("parseLimit", () => {
  it("accepts whole numbers in range", () => {
    expect(parseLimit(" 20 ", 100)).toBe(20);
    expect(parseLimit("100", 100)).toBe(100);
  });

  it("rejects blanks, zero, fractions and out-of-range values", () => {
    for (const text of ["", "0", "1.5", "-3", "abc", "101"]) {
      expect(parseLimit(text, 100)).toBeNull();
    }
  });
});

describe("channelHandle", () => {
  it("reads the @handle of a channel URL", () => {
    expect(channelHandle("https://www.youtube.com/@kiln/videos")).toBe("@kiln");
    expect(channelHandle("https://www.youtube.com/channel/UC123")).toBeNull();
    expect(channelHandle(null)).toBeNull();
  });
});
