import { describe, expect, it } from "vitest";
import {
  catalogDenominator,
  feedSearchStatusLabel,
  formatCatalogProgress,
  formatMatchReasonTip,
  formatSearchMatchCount,
  visibleMatchReasonTip,
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
        complete: true,
      })
    ).toBe("1000/1000 indexed");
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
  });
});
