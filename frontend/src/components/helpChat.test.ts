import { describe, expect, it } from "vitest";
import {
  type HelpMessage,
  historyForRequest,
  isHelpThread,
  parseSources,
} from "./helpChat";

const msg = (i: number, content = `turn ${i}`): HelpMessage => ({
  id: String(i),
  role: i % 2 ? "assistant" : "user",
  content,
});

describe("historyForRequest", () => {
  it("sends the latest finished turns within the server's limits", () => {
    const thread = Array.from({ length: 30 }, (_, i) => msg(i));
    thread.push(msg(30, "   "));
    thread[29] = msg(29, "x".repeat(9000));
    const history = historyForRequest(thread);
    expect(history).toHaveLength(12);
    expect(history[0]).toEqual({ role: "user", content: "turn 18" });
    expect(history[11].content).toHaveLength(8000);
  });
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
