import { describe, expect, it } from "vitest";
import {
  findCaptionLineIndex,
  parseVttLines,
  parseVttTimestamp,
  revealedWordCount,
  shouldHoldCaption,
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

  it("merges duplicate rollup cues instead of leaving a coverage hole", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Hello

00:00:02.000 --> 00:00:04.000
Hello

00:00:04.200 --> 00:00:06.000
World
`;
    const lines = parseVttLines(vtt);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("Hello");
    expect(lines[0].endSec).toBe(4.2);
    expect(findCaptionLineIndex(lines, 3)).toBe(0);
    expect(findCaptionLineIndex(lines, 4.1)).toBe(0);
  });

  it("does not clip overlapping cues, and finds the earlier line after a short later cue ends", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
Hello world

00:00:02.000 --> 00:00:02.400
insert
`;
    const lines = parseVttLines(vtt);
    expect(lines[0].endSec).toBe(5);
    expect(findCaptionLineIndex(lines, 2.2)).toBe(1);
    expect(findCaptionLineIndex(lines, 3)).toBe(0);
  });

  it("holds the previous line through a short gap until the next cue", () => {
    const lines = parseVttLines(`WEBVTT

00:00:01.000 --> 00:00:02.000
Hello

00:00:03.000 --> 00:00:04.000
World
`);
    expect(shouldHoldCaption(lines, 0, 2.3)).toBe(true);
    expect(shouldHoldCaption(lines, 0, 2.95)).toBe(false);
    expect(shouldHoldCaption(lines, 0, 0.5)).toBe(false);
  });

  it("reveals the first word at cue start even if karaoke tags are slightly later", () => {
    const lines = parseVttLines(`WEBVTT

00:00:01.000 --> 00:00:03.000
<00:00:01.200><c>Hello</c> <00:00:01.500><c>world</c>
`);
    expect(revealedWordCount(lines[0], 1.05)).toBe(1);
    expect(revealedWordCount(lines[0], 1.4)).toBe(1);
    expect(revealedWordCount(lines[0], 1.6)).toBe(2);
  });
});
