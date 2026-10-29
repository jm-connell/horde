import { describe, expect, it } from "vitest";
import {
  STREAM_WATCH_INTERVAL_MS,
  StreamWatchReporter,
  type WatchedStream,
} from "./useStreamWatchReporter";
import type { StreamWatchWrite } from "../types";

const A: WatchedStream = {
  url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
  title: "A",
  channel: "Chan",
  durationSec: 600,
};
const B: WatchedStream = { ...A, url: "https://youtu.be/bbbbbbbbbbb" };

function reporter() {
  const sent: StreamWatchWrite[] = [];
  let now = 0;
  const r = new StreamWatchReporter(
    (p) => sent.push(p),
    () => now
  );
  return { r, sent, tick: (ms: number) => (now += ms) };
}

describe("StreamWatchReporter", () => {
  it("sends nothing for a stream opened and left", () => {
    const { r, sent } = reporter();
    r.report(A, 5);
    r.report(A, 12);
    r.flush();
    expect(sent).toEqual([]);
  });

  it("sends once it counts, then at most every interval", () => {
    const { r, sent, tick } = reporter();
    r.report(A, 20);
    expect(sent.map((p) => p.position_sec)).toEqual([20]);
    tick(10_000);
    r.report(A, 30);
    expect(sent).toHaveLength(1);
    tick(STREAM_WATCH_INTERVAL_MS);
    r.report(A, 60);
    expect(sent.map((p) => p.position_sec)).toEqual([20, 60]);
    expect(sent[1]).toMatchObject({ duration_sec: 600, finished: false });
  });

  it("flushes the previous stream when another starts", () => {
    const { r, sent } = reporter();
    r.report(A, 25);
    r.report(A, 40);
    r.report(B, 1);
    expect(sent.map((p) => [p.url, p.position_sec])).toEqual([
      [A.url, 25],
      [A.url, 40],
    ]);
  });

  it("records the end as finished, but never a live broadcast", () => {
    const { r, sent } = reporter();
    r.finish(A);
    r.report({ ...B, live: true }, 300);
    r.finish({ ...B, live: true });
    expect(sent).toEqual([
      expect.objectContaining({
        url: A.url,
        position_sec: 600,
        finished: true,
      }),
    ]);
  });
});
