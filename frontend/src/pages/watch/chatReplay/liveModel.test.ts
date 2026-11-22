import { describe, expect, it } from "vitest";
import type {
  ChatReplayItem,
  LiveChatPage,
  StreamPreviewMeta,
} from "../../../types";
import type { WatchSource } from "../useWatchVideo";
import { CHAT_KEEP, chatTarget } from "./model";
import { mergeLive, needsLiveReset, unavailableNote } from "./liveModel";

const T0 = 1_763_740_800_000;

function item(id: string, offset = T0): ChatReplayItem {
  return {
    id,
    offset_ms: offset,
    kind: "text",
    author: "Ada",
    badges: [],
    runs: [{ text: id }],
  };
}

function page(items: ChatReplayItem[], removed: string[] = []): LiveChatPage {
  return {
    status: "ok",
    items,
    removed,
    next_after: 1,
    earliest_ms: T0,
    cutoff_ms: T0,
  };
}

describe("mergeLive", () => {
  it("appends new messages once and drops deleted ones", () => {
    const list = mergeLive([], page([item("a"), item("b")]), false);
    expect(
      mergeLive(list, page([item("b"), item("c")], ["a"]), false).map(
        (i) => i.id
      )
    ).toEqual(["b", "c"]);
  });

  it("a reset starts over", () => {
    expect(
      mergeLive([item("a")], page([item("z")]), true).map((i) => i.id)
    ).toEqual(["z"]);
  });

  it("keeps at most CHAT_KEEP", () => {
    const many = Array.from({ length: CHAT_KEEP + 50 }, (_, n) =>
      item(`m${n}`)
    );
    const kept = mergeLive([], page(many), false);
    expect(kept).toHaveLength(CHAT_KEEP);
    expect(kept[kept.length - 1].id).toBe(`m${CHAT_KEEP + 49}`);
  });
});

describe("needsLiveReset", () => {
  it("only a scrub back reads afresh", () => {
    expect(needsLiveReset(null, 0)).toBe(false);
    expect(needsLiveReset(0, 2_000)).toBe(false); // drift
    expect(needsLiveReset(0, 60_000)).toBe(true); // scrubbed back a minute
    expect(needsLiveReset(60_000, 0)).toBe(false); // back to live: newer messages follow
  });
});

describe("unavailableNote", () => {
  it("says from when chat is missing", () => {
    const d = new Date(T0);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(unavailableNote(T0, T0 - 1)).toBe(
      `Chat from before ${hhmm} isn't available.`
    );
    expect(unavailableNote(T0, T0)).toBeNull();
    expect(unavailableNote(null, T0)).toBeNull();
  });
});

describe("chatTarget for a live stream", () => {
  it("is live and known", () => {
    const source: WatchSource = {
      kind: "stream",
      url: "https://www.youtube.com/watch?v=livevideo01",
      meta: { is_live: true } as StreamPreviewMeta,
    };
    expect(chatTarget(source)).toEqual({
      youtubeId: "livevideo01",
      known: true,
      live: true,
    });
  });
});
