import { describe, expect, it } from "vitest";
import {
  findCaptionLineIndex,
  parseVttLines,
  parseVttTimestamp,
} from "./vtt";

describe("vtt", () => {
  it("parses timestamps", () => {
    expect(parseVttTimestamp("00:01:02.500")).toBe(62.5);
  });

  it("parses simple cues and finds active line", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello world

00:00:03.000 --> 00:00:05.000
Second line
`;
    const lines = parseVttLines(vtt);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("Hello world");
    expect(findCaptionLineIndex(lines, 2)).toBe(0);
    expect(findCaptionLineIndex(lines, 4)).toBe(1);
    expect(findCaptionLineIndex(lines, 0.5)).toBe(-1);
  });

  it("decodes HTML and leftover YouTube entities", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello&nbsp;world &gt;&gt; &nsps speaker

00:00:03.000 --> 00:00:05.000
Tom &amp; Jerry &#39;s &amp;nbsp;cue
`;
    const lines = parseVttLines(vtt);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("Hello world >> speaker");
    expect(lines[1].text).toBe("Tom & Jerry 's cue");
  });
});
