import { describe, expect, it } from "vitest";
import {
  buildVideoFilters,
  defaultSortState,
  readLibraryParams,
  sortAfterChange,
  sortAfterToggle,
  withoutTabParam,
} from "./libraryQuery";

describe("readLibraryParams", () => {
  it("reads the channel and tag from the address", () => {
    expect(
      readLibraryParams(new URLSearchParams("channel=Kiln&tag=craft"))
    ).toEqual({
      channel: "Kiln",
      tag: "craft",
      legacyFeedTab: false,
    });
  });

  it("is empty on the home page", () => {
    expect(readLibraryParams(new URLSearchParams(""))).toEqual({
      channel: null,
      tag: null,
      legacyFeedTab: false,
    });
  });

  it("flags the old feed tab only when a channel is open", () => {
    expect(
      readLibraryParams(new URLSearchParams("channel=Kiln&tab=feed"))
        .legacyFeedTab
    ).toBe(true);
    expect(
      readLibraryParams(new URLSearchParams("tab=feed")).legacyFeedTab
    ).toBe(false);
    expect(
      readLibraryParams(new URLSearchParams("channel=Kiln&tab=other"))
        .legacyFeedTab
    ).toBe(false);
  });
});

describe("withoutTabParam", () => {
  it("drops the tab and keeps the rest without touching the input", () => {
    const input = new URLSearchParams("channel=Kiln&tab=feed");
    expect(withoutTabParam(input).toString()).toBe("channel=Kiln");
    expect(input.get("tab")).toBe("feed");
  });
});

describe("sort state", () => {
  it("seeds a random default and leaves others unseeded", () => {
    expect(defaultSortState("random", 7)).toEqual({
      sort: "random",
      order: "desc",
      randomSeed: 7,
    });
    expect(defaultSortState("title", 7)).toEqual({
      sort: "title",
      order: "desc",
      randomSeed: undefined,
    });
  });

  it("keeps the direction on a change, except file size which starts descending", () => {
    const asc = { sort: "title", order: "asc" } as const;
    expect(sortAfterChange(asc, "duration", 5)).toEqual({
      sort: "duration",
      order: "asc",
      randomSeed: undefined,
    });
    expect(sortAfterChange(asc, "file_size", 5).order).toBe("desc");
    expect(sortAfterChange(asc, "random", 5).randomSeed).toBe(5);
  });

  it("flips the direction, and reshuffles instead for a random sort", () => {
    expect(sortAfterToggle({ sort: "title", order: "desc" }, 1)).toEqual({
      sort: "title",
      order: "asc",
    });
    expect(
      sortAfterToggle({ sort: "random", order: "desc", randomSeed: 1 }, 9)
    ).toEqual({ sort: "random", order: "desc", randomSeed: 9 });
  });
});

describe("buildVideoFilters", () => {
  it("leaves out empty filters", () => {
    expect(
      buildVideoFilters({
        search: "",
        channel: null,
        tag: null,
        sort: "title",
        order: "asc",
        randomSeed: 3,
      })
    ).toEqual({
      q: undefined,
      channel: undefined,
      tag: undefined,
      sort: "title",
      order: "asc",
      seed: undefined,
    });
  });

  it("passes the seed only for a random sort", () => {
    const base = {
      search: "kiln",
      channel: "Kiln",
      tag: "craft",
      order: "desc" as const,
      randomSeed: 3,
    };
    expect(buildVideoFilters({ ...base, sort: "random" })).toMatchObject({
      q: "kiln",
      channel: "Kiln",
      tag: "craft",
      seed: 3,
    });
    expect(buildVideoFilters({ ...base, sort: "title" }).seed).toBeUndefined();
  });
});
