import { describe, expect, it } from "vitest";
import type { Video } from "../types";
import {
  isQueuedStream,
  queueKey,
  type QueuedStream,
  withEntryAtEnd,
  withEntryFirst,
  withoutKey,
  withoutStream,
  withoutVideo,
} from "./playbackQueue";

const video = (id: number) => ({ id, title: `v${id}` }) as unknown as Video;
const stream = (url: string, href = `/watch?url=${url}`): QueuedStream => ({
  queue_kind: "stream",
  url,
  href,
  title: url,
  channel: null,
  thumbnail: null,
  duration: null,
});

describe("playback queue", () => {
  it("tells library videos and streams apart, by key too", () => {
    expect(isQueuedStream(video(1))).toBe(false);
    expect(isQueuedStream(stream("a"))).toBe(true);
    expect(queueKey(video(1))).toBe("v:1");
    expect(queueKey(stream("a"))).toBe("s:a");
  });

  it("adds each entry once and can move one to the front", () => {
    let q = withEntryAtEnd([], video(1));
    q = withEntryAtEnd(q, stream("a"));
    q = withEntryAtEnd(q, stream("a"));
    expect(q.map(queueKey)).toEqual(["v:1", "s:a"]);
    q = withEntryFirst(q, stream("a"));
    expect(q.map(queueKey)).toEqual(["s:a", "v:1"]);
    expect(withoutKey(q, "v:1").map(queueKey)).toEqual(["s:a"]);
  });

  it("drops what starts playing, including a stream that links to that video", () => {
    const q = [video(1), stream("a", "/watch/2"), stream("b")];
    expect(withoutVideo(q, 2).map(queueKey)).toEqual(["v:1", "s:b"]);
    expect(withoutVideo(q, 1).map(queueKey)).toEqual(["s:a", "s:b"]);
    expect(withoutStream(q, "b").map(queueKey)).toEqual(["v:1", "s:a"]);
  });
});
