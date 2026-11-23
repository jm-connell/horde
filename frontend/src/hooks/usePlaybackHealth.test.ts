import { describe, expect, it } from "vitest";
import {
  FrameDropWatch,
  POLL_MS,
  SUSTAINED_MS,
  type FrameSample,
} from "./usePlaybackHealth";

/** One sample per poll for `ms`, 30 fps decoded; true when any asks to downgrade. */
function run(
  watch: FrameDropWatch,
  ms: number,
  sample: { dropRatio: number; focused: boolean },
  start = { now: 0, dropped: 0, decoded: 0 }
): {
  downgraded: boolean;
  end: { now: number; dropped: number; decoded: number };
} {
  let downgraded = false;
  let { now, dropped, decoded } = start;
  const perPoll = (30 * POLL_MS) / 1000;
  for (let t = 0; t <= ms; t += POLL_MS) {
    const s: FrameSample = { now, dropped, decoded, focused: sample.focused };
    if (watch.check(s)) downgraded = true;
    now += POLL_MS;
    decoded += perPoll;
    dropped += perPoll * sample.dropRatio;
  }
  return { downgraded, end: { now, dropped, decoded } };
}

describe("FrameDropWatch", () => {
  it("asks to downgrade after frames keep dropping while the window has focus", () => {
    const watch = new FrameDropWatch();
    const { downgraded } = run(watch, SUSTAINED_MS + 2 * POLL_MS, {
      dropRatio: 0.5,
      focused: true,
    });
    expect(downgraded).toBe(true);
  });

  it("leaves a short burst of dropped frames alone", () => {
    const watch = new FrameDropWatch();
    const burst = run(watch, SUSTAINED_MS - 2 * POLL_MS, {
      dropRatio: 0.5,
      focused: true,
    });
    const after = run(
      watch,
      SUSTAINED_MS,
      { dropRatio: 0, focused: true },
      burst.end
    );
    expect(burst.downgraded || after.downgraded).toBe(false);
  });

  it("ignores dropped frames while another window has focus (a game on the other monitor)", () => {
    const watch = new FrameDropWatch();
    const { downgraded } = run(watch, 10 * SUSTAINED_MS, {
      dropRatio: 0.9,
      focused: false,
    });
    expect(downgraded).toBe(false);
  });

  it("does not count frames dropped while unfocused once focus comes back", () => {
    const watch = new FrameDropWatch();
    const away = run(watch, 10 * SUSTAINED_MS, {
      dropRatio: 0.9,
      focused: false,
    });
    const back = run(
      watch,
      2 * SUSTAINED_MS,
      { dropRatio: 0, focused: true },
      away.end
    );
    expect(back.downgraded).toBe(false);
  });
});
