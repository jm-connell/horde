import { describe, expect, it } from "vitest";
import type { AskSearchHit, ChannelFeedEntry, Video } from "../../types";
import {
  arrangeResults,
  layoutItems,
  queryTerms,
  scoreResults,
  textRelevance,
  YOUTUBE_SLOTS,
  type MixedItem,
  type MixedLayout,
} from "./mixResults";

let nextId = 1;
function video(title: string, extra: Partial<Video> = {}): Video {
  const id = nextId++;
  return {
    id,
    title,
    channel: "Some channel",
    tags: [],
    description: null,
    notes: null,
    source_url: `https://www.youtube.com/watch?v=lib${String(id).padStart(8, "0")}`,
    file_path: `/v/${id}.mp4`,
    ...extra,
  } as Video;
}
function entry(
  id: string,
  title: string,
  channel = "Elsewhere"
): ChannelFeedEntry {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    channel,
    in_library: false,
    youtube_watched: false,
  };
}
function hit(ytId: string, snippet: string, title = "A talk"): AskSearchHit {
  return {
    channel_id: 1,
    channel_name: "Talker",
    yt_id: ytId,
    title,
    published_at: null,
    library_video_id: null,
    start_sec: 60,
    end_sec: 120,
    snippet,
    in_description: false,
  } as AskSearchHit;
}
const keys = (items: MixedItem[]) => items.map((i) => i.key);
const ytKey = (v: Video) => `yt:${v.source_url!.split("v=")[1]}`;

interface Input {
  query: string;
  library?: Video[];
  otherLibrary?: Video[];
  stream?: ChannelFeedEntry[];
  said?: AskSearchHit[];
  /** Null: YouTube search off. */
  youtube?: { entries: ChannelFeedEntry[]; settled: boolean } | null;
  localSettled?: boolean;
}

/** Lay out `input` on top of `prev` (a fresh layout without one). */
function arrange(input: Input, prev: MixedLayout | null = null) {
  const scored = scoreResults({
    query: input.query,
    library: input.library ?? [],
    otherLibrary: input.otherLibrary ?? [],
    stream: input.stream ?? [],
    said: input.said ?? [],
    youtube: input.youtube?.entries ?? [],
  });
  return arrangeResults(prev, scored, {
    query: input.query,
    localSettled: input.localSettled ?? true,
    youtubeOn: input.youtube != null,
    youtubeSettled: input.youtube?.settled ?? false,
  });
}
function mix(input: Input): MixedItem[] {
  const layout = arrange(input);
  if (!layout) throw new Error("no layout");
  return layoutItems(layout);
}

describe("textRelevance", () => {
  it("weighs a title match above a description match", () => {
    const terms = queryTerms("timing belt");
    const inTitle = textRelevance(terms, { title: "Timing belt swap" });
    const inText = textRelevance(terms, { title: "Swap", text: "timing belt" });
    expect(inTitle).toBeGreaterThan(inText);
    expect(inText).toBeGreaterThan(0);
  });

  it("counts endings and ignores stop words", () => {
    expect(queryTerms("the belts of a car")).toEqual(["belts", "car"]);
    expect(textRelevance(["belt"], { title: "Belts explained" })).toBe(1);
    expect(textRelevance(["belt"], { title: "Seatbelt" })).toBe(0);
  });

  it("gives the whole phrase a bonus", () => {
    const terms = queryTerms("water pump");
    expect(textRelevance(terms, { title: "water pump" })).toBeGreaterThan(
      textRelevance(terms, { title: "pump the water" })
    );
  });
});

describe("scoreResults", () => {
  it("puts an equally good library video before a stream one", () => {
    const lib = video("Timing belt guide");
    const items = mix({
      query: "timing belt",
      library: [lib],
      stream: [entry("str00000001", "Timing belt guide")],
    });
    expect(keys(items)).toEqual([ytKey(lib), "yt:str00000001"]);
  });

  it("lets a much better stream result beat a weak library match", () => {
    const weak = video("Garage tour", { description: "a belt somewhere" });
    const items = mix({
      query: "timing belt replacement",
      library: [weak],
      stream: [entry("str00000002", "Timing belt replacement")],
    });
    expect(items[0].key).toBe("yt:str00000002");
  });

  it("attaches what was said to the video's card instead of a second card", () => {
    const lib = video("Engine work");
    const items = mix({
      query: "timing belt",
      library: [lib],
      said: [
        hit(
          ytKey(lib).slice(3),
          "change the \u0002timing\u0003 \u0002belt\u0003"
        ),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind === "library" && items[0].moments).toHaveLength(1);
  });

  it("finds the library copy a transcript hit names even without a YouTube link", () => {
    const lib = video("Engine work", { source_url: null });
    const said = {
      ...hit("noLink00001", "\u0002belt\u0003"),
      library_video_id: lib.id,
    };
    const matched = mix({ query: "belt", library: [lib], said: [said] });
    expect(keys(matched)).toEqual([`v${lib.id}`]);
    const promoted = mix({ query: "belt", otherLibrary: [lib], said: [said] });
    expect(keys(promoted)).toEqual([`v${lib.id}`]);
  });

  it("shows a library video found only by its captions as the library copy", () => {
    const other = video("Engine work");
    const items = mix({
      query: "timing belt",
      otherLibrary: [other],
      said: [
        hit(ytKey(other).slice(3), "the \u0002timing\u0003 \u0002belt\u0003"),
      ],
    });
    expect(keys(items)).toEqual([ytKey(other)]);
    expect(items[0].kind).toBe("library");
  });

  it("ranks a video found only by its comments after one whose title matches", () => {
    const byTitle = video("Timing belt guide");
    const byComment = video("Engine bay tour", {
      match_reason: { source: "comments", snippet: "great timing belt tips" },
    });
    const items = mix({ query: "timing belt", library: [byComment, byTitle] });
    expect(keys(items)).toEqual([ytKey(byTitle), ytKey(byComment)]);
  });

  it("turns a transcript hit on a video nobody has into a card to stream", () => {
    const items = mix({
      query: "belt",
      said: [hit("said0000001", "a \u0002belt\u0003", "Belt talk")],
    });
    expect(items[0]).toMatchObject({ kind: "remote", source: "said" });
  });

  it("does not show a YouTube result again when captions already found it", () => {
    const items = mix({
      query: "belt",
      said: [hit("dupe0000001", "a \u0002belt\u0003", "Belt talk")],
      youtube: { entries: [entry("dupe0000001", "Belt talk")], settled: true },
    });
    expect(keys(items)).toEqual(["yt:dupe0000001"]);
  });
});

describe("arrangeResults", () => {
  const library = Array.from({ length: 12 }, (_, i) =>
    video(`Timing belt part ${i}`)
  );
  const query = "timing belt";
  const youtube = Array.from({ length: 6 }, (_, i) =>
    entry(`yt00000000${i}`, i === 5 ? "Timing belt" : `Something ${i}`)
  );

  it("waits for the library, catalogs and captions before the first layout", () => {
    expect(arrange({ query, library, localSettled: false })).toBeNull();
  });

  it("holds YouTube's places, and moves nothing when it lands", () => {
    const pending = arrange({
      query,
      library,
      youtube: { entries: [], settled: false },
    })!;
    const before = layoutItems(pending);
    const slots = before.flatMap((item, i) =>
      item.kind === "slot" ? [i] : []
    );
    expect(slots).toEqual(
      YOUTUBE_SLOTS.map((p, i) => Math.min(p, library.length + i))
    );

    const landed = layoutItems(
      arrange(
        { query, library, youtube: { entries: youtube, settled: true } },
        pending
      )!
    );
    before.forEach((item, i) => {
      if (item.kind === "slot") {
        expect(landed[i]).toMatchObject({ kind: "remote", source: "youtube" });
      } else {
        expect(landed[i].key).toBe(item.key);
      }
    });
    // The best-matching YouTube result takes the first place; the rest
    // join at the end.
    expect(landed[slots[0]].key).toBe("yt:yt000000005");
    expect(landed).toHaveLength(library.length + youtube.length);
  });

  it("fills places YouTube left empty with the last card, moving only it", () => {
    const pending = arrange({
      query,
      library,
      youtube: { entries: [], settled: false },
    })!;
    const before = layoutItems(pending);
    const landed = layoutItems(
      arrange(
        {
          query,
          library,
          youtube: { entries: youtube.slice(0, 1), settled: true },
        },
        pending
      )!
    );
    expect(landed).toHaveLength(library.length + 1);
    const lastCards = before.filter((i) => i.kind !== "slot").slice(-3);
    before.forEach((item, i) => {
      if (item.kind === "slot" || i >= landed.length) return;
      // Every card stays put, except the last ones, which took empty places.
      if (!lastCards.some((c) => c.key === item.key)) {
        expect(landed[i].key).toBe(item.key);
      }
    });
  });

  it("adds more YouTube results at the end without touching its places", () => {
    const first = arrange({
      query,
      library,
      youtube: { entries: youtube.slice(0, 4), settled: true },
    })!;
    const better = entry("ytbest00001", "Timing belt timing belt");
    const more = arrange(
      {
        query,
        library,
        youtube: { entries: [...youtube.slice(0, 4), better], settled: true },
      },
      first
    )!;
    expect(more.order.slice(0, first.order.length)).toEqual(first.order);
    expect(more.order[more.order.length - 1]).toBe("yt:ytbest00001");
  });

  it("keeps every card while a source reloads after a download", () => {
    const stream = [entry("str00000009", "Timing belt video")];
    const first = arrange({
      query,
      library: library.slice(0, 3),
      stream,
      youtube: { entries: youtube.slice(0, 2), settled: true },
    })!;
    // The catalog and YouTube are searching again, with nothing yet.
    const reloading = arrange(
      {
        query,
        library: library.slice(0, 3),
        youtube: { entries: [], settled: false },
        localSettled: false,
      },
      first
    )!;
    expect(reloading.order).toEqual(first.order);
    // The streamed video was downloaded: its library copy takes its place.
    const downloaded = video("Timing belt video", {
      source_url: "https://www.youtube.com/watch?v=str00000009",
    });
    const after = arrange(
      {
        query,
        library: [...library.slice(0, 3), downloaded],
        youtube: { entries: youtube.slice(0, 2), settled: true },
      },
      reloading
    )!;
    expect(after.order).toEqual(first.order);
    expect(after.items.get("yt:str00000009")?.kind).toBe("library");
  });

  it("starts over for a new query", () => {
    const first = arrange({ query, library })!;
    expect(
      arrange({ query: "kiln", library: [], localSettled: false }, first)
    ).toBeNull();
  });

  it("puts YouTube's places after the last result when there are few", () => {
    const items = mix({
      query: "kiln",
      library: [video("Kiln")],
      youtube: { entries: [], settled: false },
    });
    expect(items.map((i) => i.kind)).toEqual([
      "library",
      "slot",
      "slot",
      "slot",
      "slot",
    ]);
  });
});
