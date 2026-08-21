import { describe, expect, it } from "vitest";
import {
  catalogDenominator,
  formatCatalogProgress,
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
