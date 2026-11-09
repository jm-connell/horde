import { describe, expect, it } from "vitest";
import {
  type HelpMessage,
  askVideoKey,
  isAskState,
  parseAskVideo,
  isHelpThread,
  parseSources,
  PROMPT_HISTORY_MAX,
  rememberPrompt,
  savedSources,
  stepPromptHistory,
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
    // The picked source is kept with it; a malformed one is not trusted.
    const picked = { scope: [], video: null };
    expect(isAskState({ threadId: null, scope: [], picked })).toBe(true);
    expect(
      isAskState({ threadId: null, scope: [], picked: { scope: 3 } })
    ).toBe(false);
  });
});

describe("videos Ask answers from", () => {
  const library = {
    library_id: 4,
    youtube_id: "ccccccccccc",
    url: null,
    title: "Belt basics",
  };
  const stream = {
    library_id: null,
    youtube_id: null,
    url: "https://www.youtube.com/watch?v=ddddddddddd",
    title: "Ridge",
  };

  it("reads a library video or a stream, and nothing else", () => {
    expect(parseAskVideo(library)).toEqual(library);
    expect(parseAskVideo(stream)).toEqual(stream);
    expect(parseAskVideo({ title: "No id" })).toBeNull();
    expect(parseAskVideo("video")).toBeNull();
    expect(askVideoKey(library)).not.toBe(askVideoKey(stream));
  });

  it("keeps a saved answer's video and a picked one", () => {
    expect(savedSources({ kind: "video", video: library })).toEqual({
      video: library,
    });
    expect(savedSources({ kind: "video", video: {} })).toEqual({});
    expect(isAskState({ threadId: null, scope: [], video: stream })).toBe(true);
    expect(isAskState({ threadId: null, scope: [], video: { id: 1 } })).toBe(
      false
    );
  });
});

describe("prompt history", () => {
  it("remembers questions, not twice in a row, and keeps the last 50", () => {
    let h: string[] = [];
    h = rememberPrompt(h, " first ");
    h = rememberPrompt(h, "first");
    h = rememberPrompt(h, "second");
    expect(h).toEqual(["first", "second"]);
    for (let i = 0; i < 60; i++) h = rememberPrompt(h, `q${i}`);
    expect(h).toHaveLength(PROMPT_HISTORY_MAX);
    expect(h[h.length - 1]).toBe("q59");
  });

  it("steps back and forward like a terminal", () => {
    const h = ["a", "b"];
    expect(stepPromptHistory(h, null, -1)).toEqual({ pos: 1, text: "b" });
    expect(stepPromptHistory(h, 1, -1)).toEqual({ pos: 0, text: "a" });
    expect(stepPromptHistory(h, 0, -1)).toBeNull();
    expect(stepPromptHistory(h, 0, 1)).toEqual({ pos: 1, text: "b" });
    // Past the newest: back to what was being typed.
    expect(stepPromptHistory(h, 1, 1)).toEqual({ pos: null, text: null });
    expect(stepPromptHistory(h, null, 1)).toBeNull();
    expect(stepPromptHistory([], null, -1)).toBeNull();
  });
});
