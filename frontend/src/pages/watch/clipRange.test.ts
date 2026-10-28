import { describe, expect, it } from "vitest";
import { clipLength, clipRequest, liveMark, parseClock } from "./clipRange";

describe("parseClock", () => {
  it("reads h:mm:ss, m:ss and plain seconds", () => {
    expect(parseClock("1:02:03")).toBe(3723);
    expect(parseClock(" 4:05 ")).toBe(245);
    expect(parseClock("95")).toBe(95);
  });

  it("refuses anything else", () => {
    expect(parseClock("")).toBeNull();
    expect(parseClock("1:2:3:4")).toBeNull();
    expect(parseClock("1:xx")).toBeNull();
  });
});

describe("clip marks", () => {
  it("sends a finished stream's own times", () => {
    const body = clipRequest(
      "u",
      "T",
      { kind: "time", sec: 60 },
      { kind: "time", sec: 90 },
      0
    );
    expect(body).toMatchObject({ start_sec: 60, end_sec: 90 });
    expect(body.start_behind_live_sec).toBeUndefined();
  });

  it("keeps live marks fixed while the live edge moves on", () => {
    // Start marked 30 s behind live at t=100 s, end 10 s behind at t=160 s.
    const start = liveMark(30, 100_000);
    const end = liveMark(10, 160_000);
    expect(clipLength(start, end)).toBe(80);
    // Sent at t=200 s: the start is now 130 s behind, the end 50 s.
    expect(clipRequest("u", null, start, end, 200_000)).toMatchObject({
      start_behind_live_sec: 130,
      end_behind_live_sec: 50,
    });
  });
});
