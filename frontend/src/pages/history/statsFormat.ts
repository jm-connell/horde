import type { HistoryStatsDay, HistoryStatsRange } from "../../types";

export const RANGE_OPTIONS: { value: HistoryStatsRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "365d", label: "Year" },
  { value: "all", label: "All time" },
];

/** "in the last 30 days" and friends, for sentences about a range. */
export function rangePhrase(range: HistoryStatsRange): string {
  switch (range) {
    case "7d":
      return "in the last 7 days";
    case "30d":
      return "in the last 30 days";
    case "365d":
      return "in the last year";
    case "all":
      return "since you started";
  }
}

/** Watch time for a tile or label: "45m", "1h 59m", "12h", "1,204h". */
export function formatWatchTime(seconds: number): string {
  if (seconds <= 0) return "0m";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 10 || rest === 0) {
    return `${Math.round(minutes / 60).toLocaleString("en-US")}h`;
  }
  return `${hours}h ${rest}m`;
}

/** The same, in words for screen readers: "1 hour 59 minutes". */
export function formatWatchTimeLong(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return seconds > 0 ? "under a minute" : "no time";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (rest) parts.push(`${rest} minute${rest === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/** A local `YYYY-MM-DD` as a Date at local midnight. */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatDay(
  day: string,
  opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  }
): string {
  return parseDay(day).toLocaleDateString(undefined, opts);
}

export interface WeekComparison {
  thisWeek: number;
  lastWeek: number;
  /** Change in percent, rounded; null when last week had nothing to compare. */
  changePct: number | null;
}

/** The last 7 days against the 7 before them (`days` oldest first). */
export function compareWeeks(days: HistoryStatsDay[]): WeekComparison {
  const sum = (list: HistoryStatsDay[]) =>
    list.reduce((total, d) => total + d.seconds, 0);
  const thisWeek = sum(days.slice(-7));
  const lastWeek = sum(days.slice(-14, -7));
  const changePct =
    lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null;
  return { thisWeek, lastWeek, changePct };
}

export interface ChartBar {
  key: string;
  /** First and last day the bar covers (the same for a daily bar). */
  start: string;
  end: string;
  seconds: number;
  finished: number;
}

/** Days per bar so a long range stays readable: one bar a week past ~3 months. */
export function binSize(dayCount: number): number {
  if (dayCount <= 92) return 1;
  if (dayCount <= 731) return 7;
  return 30;
}

/** Fold `days` into bars of `binSize` days, newest bar ending today. */
export function binDays(days: HistoryStatsDay[]): ChartBar[] {
  const size = binSize(days.length);
  const bars: ChartBar[] = [];
  // Bin from the end so the last bar is always a whole, current one.
  for (let end = days.length; end > 0; end -= size) {
    const slice = days.slice(Math.max(0, end - size), end);
    bars.push({
      key: slice[0].day,
      start: slice[0].day,
      end: slice[slice.length - 1].day,
      seconds: slice.reduce((t, d) => t + d.seconds, 0),
      finished: slice.reduce((t, d) => t + d.finished, 0),
    });
  }
  return bars.reverse();
}

/** "Tue, Mar 10" or "Mar 4 – Mar 10" for a bar. */
export function barLabel(bar: ChartBar): string {
  if (bar.start === bar.end) return formatDay(bar.start);
  const short: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${formatDay(bar.start, short)} – ${formatDay(bar.end, short)}`;
}

/** Gridline values for an axis up to `max` seconds: 2–4 round steps. */
export function axisTicks(max: number): number[] {
  if (max <= 0) return [];
  const steps = [
    5 * 60,
    10 * 60,
    15 * 60,
    30 * 60,
    3600,
    2 * 3600,
    3 * 3600,
    6 * 3600,
    12 * 3600,
    24 * 3600,
    48 * 3600,
    100 * 3600,
    250 * 3600,
  ];
  const step = steps.find((s) => max / s <= 4) ?? steps[steps.length - 1];
  const ticks: number[] = [];
  for (let v = step; v <= max; v += step) ticks.push(v);
  return ticks;
}

/** 0 (nothing) to 4 (the busiest cell) for the weekday × hour chart. */
export function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** "18:00" style hour label in the viewer's locale ("6 PM" in en-US). */
export function hourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: "numeric",
  });
}

/** "42%" with no decimals, "<1%" for a sliver. */
export function formatShare(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/** How far an arrow key moves through a chart's marks (`cols` per row); null for other keys. */
export function chartKeyStep(key: string, cols: number): number | null {
  switch (key) {
    case "ArrowLeft":
      return -1;
    case "ArrowRight":
      return 1;
    case "ArrowUp":
      return cols > 1 ? -cols : null;
    case "ArrowDown":
      return cols > 1 ? cols : null;
    default:
      return null;
  }
}
