import { describe, expect, it } from "vitest";
import type { AskSearchHit, ChannelFeedEntry, Video } from "../../types";
import {
  mixResults,
  queryTerms,
  textRelevance,
  YOUTUBE_SLOTS,
  type MixedItem,
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
const base = {
  library: [] as Video[],
  otherLibrary: [] as Video[],
  stream: [] as ChannelFeedEntry[],
  said: [] as AskSearchHit[],
  youtube: null,
};

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

describe("mixResults", () => {
  it("puts an equally good library video before a stream or YouTube one", () => {
    const lib = video("Timing belt guide");
    const items = mixResults({
      ...base,
      query: "timing belt",
      library: [lib],
      stream: [entry("str00000001", "Timing belt guide")],
    });
    expect(keys(items)).toEqual([`v${lib.id}`, "stream:str00000001"]);
  });

  it("lets a much better stream result beat a weak library match", () => {
    const weak = video("Garage tour", { description: "a belt somewhere" });
    const items = mixResults({
      ...base,
      query: "timing belt replacement",
      library: [weak],
      stream: [entry("str00000002", "Timing belt replacement")],
    });
    expect(items[0].key).toBe("stream:str00000002");
  });

  it("attaches what was said to the video's card instead of a second card", () => {
    const lib = video("Engine work");
    const ytId = lib.source_url!.split("v=")[1];
    const items = mixResults({
      ...base,
      query: "timing belt",
      library: [lib],
      said: [hit(ytId, "change the \u0002timing\u0003 \u0002belt\u0003")],
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind === "library" && items[0].moments).toHaveLength(1);
  });

  it("shows a library video found only by its captions as the library copy", () => {
    const other = video("Engine work");
    const ytId = other.source_url!.split("v=")[1];
    const items = mixResults({
      ...base,
      query: "timing belt",
      otherLibrary: [other],
      said: [hit(ytId, "the \u0002timing\u0003 \u0002belt\u0003")],
    });
    expect(keys(items)).toEqual([`v${other.id}`]);
  });

  it("turns a transcript hit on a video nobody has into a card to stream", () => {
    const items = mixResults({
      ...base,
      query: "belt",
      said: [hit("said0000001", "a \u0002belt\u0003", "Belt talk")],
    });
    expect(items[0]).toMatchObject({ kind: "remote", source: "said" });
  });

  it("keeps YouTube's places while it searches, and moves nothing when it lands", () => {
    const library = Array.from({ length: 12 }, (_, i) =>
      video(`Timing belt part ${i}`)
    );
    const query = "timing belt";
    const pending = mixResults({
      ...base,
      query,
      library,
      youtube: { entries: [], pending: true },
    });
    const slots = pending.flatMap((item, i) =>
      item.kind === "slot" ? [i] : []
    );
    expect(slots).toEqual(
      YOUTUBE_SLOTS.slice(0, 4).map((p, i) => Math.min(p, 12 + i))
    );

    const youtube = Array.from({ length: 6 }, (_, i) =>
      entry(`yt00000000${i}`, i === 5 ? "Timing belt" : `Something ${i}`)
    );
    const landed = mixResults({
      ...base,
      query,
      library,
      youtube: { entries: youtube, pending: false },
    });
    // Every card that was showing is where it was; YouTube fills the places.
    pending.forEach((item, i) => {
      if (item.kind === "slot") {
        expect(landed[i]).toMatchObject({ kind: "remote", source: "youtube" });
      } else {
        expect(landed[i].key).toBe(item.key);
      }
    });
    // The best-matching YouTube result takes the first place.
    expect(landed[slots[0]].key).toBe("youtube:yt000000005");
    expect(landed).toHaveLength(12 + 6);
  });

  it("puts YouTube's places after the last result when there are few", () => {
    const items = mixResults({
      ...base,
      query: "kiln",
      library: [video("Kiln")],
      youtube: { entries: [], pending: true },
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
