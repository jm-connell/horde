import { describe, expect, it } from "vitest";
import {
  type HelpMessage,
  isAskState,
  isHelpThread,
  parseSources,
  savedSources,
} from "./helpChat";

const msg = (i: number, content = `turn ${i}`): HelpMessage => ({
  id: String(i),
  role: i % 2 ? "assistant" : "user",
  content,
});

describe("stored thread", () => {
  it("accepts a saved thread and rejects anything else", () => {
    expect(isHelpThread([msg(0), { ...msg(1), sources: [] }])).toBe(true);
    expect(isHelpThread([{ id: "1", role: "system", content: "x" }])).toBe(
      false
    );
    expect(isHelpThread({})).toBe(false);
  });

  it("keeps only well-formed sources", () => {
    const ok = { path: "docs/a.md", title: "A", url: "/wiki/a/" };
    expect(parseSources([ok, { path: 1 }, null])).toEqual([ok]);
    expect(parseSources("nope")).toEqual([]);
  });
});

describe("saved Ask messages", () => {
  const ref = {
    n: 1,
    channel: "The Car Care Nut",
    title: "Belts",
    yt_id: "abcdefghijk",
    published_at: null,
    start_sec: 28,
    library_video_id: null,
    line: "the timing belt",
    is_description: false,
  };

  it("reads channel answers' references and help answers' sources", () => {
    expect(
      savedSources({
        kind: "channels",
        channels: [{ id: 3, name: "The Car Care Nut" }, { id: "x" }],
        references: [ref, { n: "bad" }],
      })
    ).toEqual({
      references: [ref],
      channels: [{ id: 3, name: "The Car Care Nut" }],
    });
    const doc = { path: "docs/a.md", title: "A", url: "/wiki/a/" };
    expect(savedSources({ kind: "help", sources: [doc] })).toEqual({
      sources: [doc],
    });
    expect(savedSources(null)).toEqual({});
  });

  it("accepts only a well-formed tab state", () => {
    expect(isAskState({ threadId: 4, scope: [] })).toBe(true);
    expect(isAskState({ threadId: "4", scope: [] })).toBe(false);
  });
});
