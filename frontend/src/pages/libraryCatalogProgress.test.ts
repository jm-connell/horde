import { describe, expect, it } from "vitest";
import {
  catalogDenominator,
  feedSearchStatusLabel,
  formatCatalogProgress,
  formatMatchReasonTip,
  formatSearchMatchCount,
  showChannelIndexButton,
  visibleMatchReasonTip,
  YOUTUBE_SEARCH_LOADING_LABEL,
  type CatalogProgress,
} from "./libraryCatalogProgress";

const base: CatalogProgress = {
  indexed: 0,
  total: null,
  maxVideos: 1000,
  complete: false,
  status: null,
  indexing: false,
};

describe("catalogDenominator", () => {
  it("uses the cap when total is unknown", () => {
    expect(catalogDenominator(base)).toBe(1000);
  });
  it("caps a larger YouTube library at maxVideos", () => {
    expect(catalogDenominator({ ...base, total: 5000, maxVideos: 1000 })).toBe(
      1000
    );
  });
  it("uses the real total when it is under the cap", () => {
    expect(catalogDenominator({ ...base, total: 80, maxVideos: 1000 })).toBe(80);
  });
});

describe("formatCatalogProgress", () => {
  it("labels empty, in-progress, and complete states", () => {
    expect(formatCatalogProgress(base)).toBe("Not indexed");
    expect(
      formatCatalogProgress({ ...base, indexing: true, indexed: 12, total: 80 })
    ).toBe("Indexing… 12/80");
    expect(
      formatCatalogProgress({
        ...base,
        complete: true,
        indexed: 80,
        total: 80,
      })
    ).toBe("Fully indexed (80)");
    expect(
      formatCatalogProgress({
        ...base,
        indexed: 1000,
        total: 5000,
        complete: false,
      })
    ).toBe("Fully indexed (1000)");
    expect(
      formatCatalogProgress({
        ...base,
        indexed: 1000,
        total: 5000,
        complete: true,
      })
    ).toBe("Fully indexed (1000)");
  });
});

describe("showChannelIndexButton", () => {
  it("hides when the catalog is complete, at the cap, or already indexing", () => {
    expect(showChannelIndexButton(null)).toBe(false);
    expect(
      showChannelIndexButton({ ...base, complete: true, indexed: 80, total: 80 })
    ).toBe(false);
    expect(
      showChannelIndexButton({
        ...base,
        indexed: 1000,
        total: 5000,
        complete: false,
      })
    ).toBe(false);
    expect(
      showChannelIndexButton({ ...base, indexing: true, indexed: 12 })
    ).toBe(false);
  });

  it("shows when the catalog is missing, incomplete, or failed", () => {
    expect(showChannelIndexButton(base)).toBe(true);
    expect(
      showChannelIndexButton({ ...base, indexed: 40, total: 80, status: "idle" })
    ).toBe(true);
    expect(
      showChannelIndexButton({ ...base, indexed: 12, status: "error" })
    ).toBe(true);
    expect(
      showChannelIndexButton({
        ...base,
        indexed: 400,
        total: 5000,
        complete: false,
      })
    ).toBe(true);
  });
});

describe("feed search status copy", () => {
  it("labels in-flight phases and match counts", () => {
    expect(feedSearchStatusLabel("idle")).toBeNull();
    expect(feedSearchStatusLabel("keywords")).toBe(
      "Searching indexed catalog…"
    );
    expect(feedSearchStatusLabel("related")).toBe("Finding related matches…");
    expect(feedSearchStatusLabel("done")).toBeNull();
    expect(YOUTUBE_SEARCH_LOADING_LABEL).toBe("Loading YouTube results…");
    expect(formatSearchMatchCount(0)).toBe("0 matches");
    expect(formatSearchMatchCount(1)).toBe("1 match");
    expect(formatSearchMatchCount(12)).toBe("12 matches");
  });
});

describe("formatMatchReasonTip", () => {
  it("quotes description, captions, and related index copy", () => {
    expect(
      formatMatchReasonTip(
        { source: "description", snippet: "wifi hotspot in the cab" },
        "wifi"
      )
    ).toBe('Matched “wifi” in the description: “wifi hotspot in the cab”');
    expect(
      formatMatchReasonTip(
        { source: "captions", snippet: "put a wifi hotspot in" },
        "wifi"
      )
    ).toBe("In captions: “put a wifi hotspot in”");
    expect(formatMatchReasonTip({ source: "related" }, "wifi")).toBe(
      "Related by search index from the title and description."
    );
    expect(formatMatchReasonTip({ source: "youtube" }, "paint")).toBe(
      "Found on YouTube (not in the local catalog)."
    );
  });

  it("hides the badge for title hits and keeps other sources", () => {
    expect(
      visibleMatchReasonTip({ source: "title", snippet: "WiFi routers" }, "wifi")
    ).toBeNull();
    expect(
      visibleMatchReasonTip(
        { source: "description", snippet: "wifi hotspot" },
        "wifi"
      )
    ).toBe('Matched “wifi” in the description: “wifi hotspot”');
    expect(visibleMatchReasonTip(null, "wifi")).toBeNull();
    expect(visibleMatchReasonTip({ source: "youtube" }, "paint")).toBe(
      "Found on YouTube (not in the local catalog)."
    );
  });
});
