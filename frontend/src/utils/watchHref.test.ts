import { describe, expect, it } from "vitest";
import { streamUrlFromHref } from "./watchHref";

describe("streamUrlFromHref", () => {
  it("reads the stream link only", () => {
    expect(
      streamUrlFromHref("/watch?url=https%3A%2F%2Fy.test%2Fw%3Fv%3D1&channel=C")
    ).toBe("https://y.test/w?v=1");
    expect(streamUrlFromHref("/watch/12")).toBeNull();
    expect(streamUrlFromHref("/watch?channel=C")).toBeNull();
    expect(streamUrlFromHref(null)).toBeNull();
  });
});
