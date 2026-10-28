import type { ClipCreate } from "../../types";

/** `1:02:03` / `4:05` / `95` → seconds, or null when it is not a time. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reduce((total, p) => total * 60 + parseInt(p, 10), 0);
}

/**
 * One end of a clip. A finished stream is marked on its own timeline; a live
 * one at a wall-clock instant, because "how far behind live" changes every
 * second while the dialog is open.
 */
export type ClipMark =
  { kind: "time"; sec: number } | { kind: "live"; atMs: number };

/** The mark for a playhead `behindSec` behind the live edge, read at `nowMs`. */
export function liveMark(behindSec: number, nowMs: number): ClipMark {
  return { kind: "live", atMs: nowMs - behindSec * 1000 };
}

/** Clip length in seconds (negative when the end is before the start). */
export function clipLength(start: ClipMark, end: ClipMark): number {
  if (start.kind === "live" && end.kind === "live") {
    return (end.atMs - start.atMs) / 1000;
  }
  if (start.kind === "time" && end.kind === "time") return end.sec - start.sec;
  return NaN;
}

/** The request body for these marks, with live marks measured at `nowMs`. */
export function clipRequest(
  url: string,
  title: string | null,
  start: ClipMark,
  end: ClipMark,
  nowMs: number
): ClipCreate {
  const body: ClipCreate = { url, title, quality_preset: "best" };
  if (start.kind === "live" && end.kind === "live") {
    body.start_behind_live_sec = Math.max(0, (nowMs - start.atMs) / 1000);
    body.end_behind_live_sec = Math.max(0, (nowMs - end.atMs) / 1000);
  } else if (start.kind === "time" && end.kind === "time") {
    body.start_sec = start.sec;
    body.end_sec = end.sec;
  }
  return body;
}
