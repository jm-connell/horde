import { describe, expect, it } from "vitest";
import {
  positionToSave,
  ProgressSaver,
  type SaverTimers,
} from "./useProgressSaver";

/** Timers the test fires by hand. */
function manualTimers() {
  let next = 1;
  const due = new Map<number, () => void>();
  const timers: SaverTimers = {
    set: (fn) => {
      const id = next++;
      due.set(id, fn);
      return id;
    },
    clear: (id) => void due.delete(id),
  };
  const fire = () => {
    const fns = [...due.values()];
    due.clear();
    fns.forEach((fn) => fn());
  };
  return { timers, fire, pending: () => due.size };
}

function saverWithLog() {
  const saved: [number, number][] = [];
  const t = manualTimers();
  const saver = new ProgressSaver((id, sec) => saved.push([id, sec]), t.timers);
  return { saver, saved, ...t };
}

describe("positionToSave", () => {
  it("counts 90% and beyond as finished", () => {
    expect(positionToSave(89, 100)).toBe(89);
    expect(positionToSave(90, 100)).toBe(0);
    expect(positionToSave(42, null)).toBe(42);
  });
});

describe("ProgressSaver", () => {
  it("saves the first report at once and at most once per interval", () => {
    const { saver, saved } = saverWithLog();
    saver.report(1, 10, 300);
    saver.report(1, 11, 300);
    saver.report(1, 12, 300);
    expect(saved).toEqual([[1, 10]]);
  });

  it("saves where the player stopped when the interval ends", () => {
    const { saver, saved, fire, pending } = saverWithLog();
    saver.report(1, 10, 300);
    // Paused (or sought) right after a save: no more reports come.
    saver.report(1, 14, 300);
    fire();
    expect(saved).toEqual([
      [1, 10],
      [1, 14],
    ]);
    // A save at the end of an interval opens the next one.
    expect(pending()).toBe(1);
    fire();
    expect(pending()).toBe(0);
    saver.report(1, 20, 300);
    expect(saved[saved.length - 1]).toEqual([1, 20]);
  });

  it("sends the unsaved position when flushed (page hidden or closed)", () => {
    const { saver, saved } = saverWithLog();
    saver.report(1, 10, 300);
    saver.report(1, 13, 300);
    saver.flush();
    saver.flush();
    expect(saved).toEqual([
      [1, 10],
      [1, 13],
    ]);
  });

  it("saves the previous video before another one's position", () => {
    const { saver, saved } = saverWithLog();
    saver.report(1, 10, 300);
    saver.report(1, 13, 300);
    saver.report(2, 4, 300);
    expect(saved).toEqual([
      [1, 10],
      [1, 13],
    ]);
  });

  it("records a finished video as 0, not its last unsaved position", () => {
    const { saver, saved, fire } = saverWithLog();
    saver.report(1, 250, 300);
    saver.report(1, 260, 300);
    saver.finish(1);
    fire();
    expect(saved).toEqual([
      [1, 250],
      [1, 0],
    ]);
  });
});
