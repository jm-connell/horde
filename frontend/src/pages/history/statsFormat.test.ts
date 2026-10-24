import { describe, expect, it } from "vitest";
import type { HistoryStatsDay } from "../../types";
import {
  axisTicks,
  binDays,
  chartKeyStep,
  compareWeeks,
  formatShare,
  formatWatchTime,
  formatWatchTimeLong,
  heatLevel,
} from "./statsFormat";

function days(seconds: number[]): HistoryStatsDay[] {
  return seconds.map((s, i) => ({
    day: `2026-01-${String(i + 1).padStart(2, "0")}`,
    seconds: s,
    finished: s > 0 ? 1 : 0,
  }));
}

describe("formatWatchTime", () => {
  it("reads as minutes, then hours and minutes, then hours", () => {
    expect(formatWatchTime(0)).toBe("0m");
    expect(formatWatchTime(20)).toBe("<1m");
    expect(formatWatchTime(45 * 60)).toBe("45m");
    expect(formatWatchTime(119 * 60)).toBe("1h 59m");
    expect(formatWatchTime(2 * 3600)).toBe("2h");
    expect(formatWatchTime(10 * 3600 + 40 * 60)).toBe("11h");
    expect(formatWatchTime(1204 * 3600)).toBe("1,204h");
  });

  it("has a spoken form", () => {
    expect(formatWatchTimeLong(0)).toBe("no time");
    expect(formatWatchTimeLong(20)).toBe("under a minute");
    expect(formatWatchTimeLong(61 * 60)).toBe("1 hour 1 minute");
    expect(formatWatchTimeLong(150 * 60)).toBe("2 hours 30 minutes");
  });
});

describe("compareWeeks", () => {
  it("compares the last seven days with the seven before", () => {
    const list = days([...Array(7).fill(100), ...Array(7).fill(150)]);
    expect(compareWeeks(list)).toEqual({
      thisWeek: 1050,
      lastWeek: 700,
      changePct: 50,
    });
  });

  it("has no percentage without a last week", () => {
    expect(compareWeeks(days([0, 0, 60])).changePct).toBeNull();
  });
});

describe("binDays", () => {
  it("keeps one bar a day for a month", () => {
    const bars = binDays(days(Array(30).fill(60)));
    expect(bars).toHaveLength(30);
    expect(bars[0].start).toBe(bars[0].end);
  });

  it("folds a year into weeks ending today", () => {
    const year = Array.from({ length: 365 }, (_, i) => ({
      day: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
      seconds: 60,
      finished: 0,
    }));
    const bars = binDays(year);
    expect(bars).toHaveLength(53);
    expect(bars[bars.length - 1].end).toBe(year[364].day);
    expect(bars[bars.length - 1].seconds).toBe(7 * 60);
    expect(bars[0].seconds).toBe(60); // the leftover day
    expect(bars.reduce((t, b) => t + b.seconds, 0)).toBe(365 * 60);
  });
});

describe("chart helpers", () => {
  it("picks two to four round gridlines", () => {
    expect(axisTicks(0)).toEqual([]);
    expect(axisTicks(44 * 60)).toEqual([900, 1800]);
    expect(axisTicks(5 * 3600)).toEqual([7200, 14400]);
  });

  it("steps heat from nothing to the busiest cell", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(1, 100)).toBe(1);
    expect(heatLevel(50, 100)).toBe(2);
    expect(heatLevel(100, 100)).toBe(4);
  });

  it("moves through rows with the arrow keys", () => {
    expect(chartKeyStep("ArrowLeft", 24)).toBe(-1);
    expect(chartKeyStep("ArrowDown", 24)).toBe(24);
    expect(chartKeyStep("ArrowUp", 1)).toBeNull();
    expect(chartKeyStep("Enter", 24)).toBeNull();
  });

  it("formats a share of the library", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.004)).toBe("<1%");
    expect(formatShare(0.234)).toBe("23%");
  });
});
