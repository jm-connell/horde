import { describe, expect, it } from "vitest";
import {
  STALL_BUFFERED_MS,
  STALL_STARVED_MS,
  StallWatch,
  type StallSample,
} from "./useStallRecovery";

/** Feed one sample a second for `ms`; true when any of them reports a stall. */
function run(
  watch: StallWatch,
  from: number,
  ms: number,
  sample: (now: number) => Omit<StallSample, "now">
): boolean {
  let stalled = false;
  for (let now = from; now <= from + ms; now += 1000) {
    if (watch.check({ now, ...sample(now) })) stalled = true;
  }
  return stalled;
}

const frozen = {
  time: 2640,
  idle: false,
  bufferedAheadSec: 20,
  buffering: false,
};

describe("StallWatch", () => {
  it("leaves playback that moves alone", () => {
    const moving = (now: number) => ({ ...frozen, time: now / 1000 });
    expect(run(new StallWatch(), 0, 60_000, moving)).toBe(false);
  });

  it("reports a playhead that stands still with media buffered", () => {
    const w = new StallWatch();
    expect(run(w, 0, STALL_BUFFERED_MS - 1000, () => frozen)).toBe(false);
    expect(w.check({ now: STALL_BUFFERED_MS, ...frozen })).toBe(true);
  });

  it("gives a stream with nothing buffered longer to load", () => {
    const starved = { ...frozen, bufferedAheadSec: 0 };
    const w = new StallWatch();
    expect(run(w, 0, STALL_STARVED_MS - 1000, () => starved)).toBe(false);
    expect(w.check({ now: STALL_STARVED_MS, ...starved })).toBe(true);
  });

  it("waits as long while the player is rebuffering", () => {
    // Shaka holds the picture until its rebuffering goal is met.
    const rebuffering = { ...frozen, bufferedAheadSec: 2, buffering: true };
    const w = new StallWatch();
    expect(run(w, 0, STALL_STARVED_MS - 1000, () => rebuffering)).toBe(false);
    expect(w.check({ now: STALL_STARVED_MS, ...rebuffering })).toBe(true);
  });

  it("leaves a slow connection that is still loading alone", () => {
    const loading = (now: number) => ({
      ...frozen,
      bufferedAheadSec: now / 10_000,
      buffering: true,
    });
    expect(run(new StallWatch(), 0, 120_000, loading)).toBe(false);
  });

  it("reports a stall once, then again if it lasts", () => {
    const w = new StallWatch();
    expect(run(w, 0, STALL_BUFFERED_MS, () => frozen)).toBe(true);
    const next = STALL_BUFFERED_MS + 1000;
    expect(run(w, next, STALL_BUFFERED_MS - 2000, () => frozen)).toBe(false);
    expect(w.check({ now: 2 * STALL_BUFFERED_MS, ...frozen })).toBe(true);
  });

  it("ignores a paused or hidden player", () => {
    const idle = () => ({ ...frozen, idle: true });
    expect(run(new StallWatch(), 0, 120_000, idle)).toBe(false);
  });

  it("starts over after a pause", () => {
    const w = new StallWatch();
    run(w, 0, STALL_BUFFERED_MS - 1000, () => frozen);
    w.check({ now: STALL_BUFFERED_MS, ...frozen, idle: true });
    const from = STALL_BUFFERED_MS + 1000;
    expect(run(w, from, STALL_BUFFERED_MS - 2000, () => frozen)).toBe(false);
  });

  it("does not count time the checks were suspended", () => {
    const w = new StallWatch();
    w.check({ now: 0, ...frozen });
    // The device slept for ten minutes with the timers frozen.
    expect(w.check({ now: 600_000, ...frozen })).toBe(false);
  });
});
