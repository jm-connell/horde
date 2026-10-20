import { describe, expect, it } from "vitest";
import { isLongStream, isPastStream, longStreamConfirm } from "./longStream";

describe("long livestream warning", () => {
  it("only applies to past streams over two hours", () => {
    expect(isLongStream(true, 2 * 3600 + 1)).toBe(true);
    expect(isLongStream(true, 2 * 3600)).toBe(false);
    expect(isLongStream(false, 10 * 3600)).toBe(false);
    expect(isLongStream(true, null)).toBe(false);
  });

  it("recognises past streams by live_status", () => {
    expect(isPastStream("was_live")).toBe(true);
    expect(isPastStream("post_live")).toBe(true);
    expect(isPastStream("is_live")).toBe(false);
    expect(isPastStream(null)).toBe(false);
  });

  it("names the stream length", () => {
    expect(longStreamConfirm(9 * 3600 + 26 * 60).body).toContain("9h 26m");
    expect(longStreamConfirm(3 * 3600).body).toContain("3h long");
    expect(longStreamConfirm(3 * 3600, 5 * 1024 ** 3).body).toContain(
      "about 5"
    );
  });
});
