/**
 * Live chat that follows the viewer's position in a live stream's DVR window:
 * the server filters its buffer at the moment being watched; these rules merge
 * what it sends, decide when a scrub back needs a fresh read, and word the note
 * for chat older than Horde holds. Pure, so it is unit-tested.
 */
import type { ChatReplayItem, LiveChatPage } from "../../../types";
import { CHAT_KEEP } from "./model";

/** Moving back this much further behind live reads the chat afresh. */
export const LIVE_RESET_MS = 5_000;

/** Add a page: drop what YouTube deleted, append new messages once. */
export function mergeLive(
  list: ChatReplayItem[],
  page: LiveChatPage,
  reset: boolean,
  keep = CHAT_KEEP
): ChatReplayItem[] {
  const removed = new Set(page.removed ?? []);
  const base = (reset ? [] : list).filter((i) => !removed.has(i.id));
  const seen = new Set(base.map((i) => i.id));
  for (const item of page.items ?? []) {
    if (!seen.has(item.id) && !removed.has(item.id)) {
      seen.add(item.id);
      base.push(item);
    }
  }
  return base.slice(-keep);
}

/** A scrub back (further behind live than before): read from that moment. */
export function needsLiveReset(
  previousBehindMs: number | null,
  behindMs: number
): boolean {
  return (
    previousBehindMs !== null && behindMs > previousBehindMs + LIVE_RESET_MS
  );
}

/** When the viewer is earlier than the oldest message Horde holds. */
export function unavailableNote(
  earliestMs: number | null | undefined,
  cutoffMs: number
): string | null {
  if (earliestMs == null || cutoffMs >= earliestMs) return null;
  const d = new Date(earliestMs);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `Chat from before ${hhmm} isn't available.`;
}
