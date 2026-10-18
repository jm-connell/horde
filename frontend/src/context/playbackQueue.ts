import type { Video } from "../types";

/**
 * A video that is not in the library (or is opened by its source link), queued
 * from a channel feed, search result or the watch page's related list. Playing
 * it opens `href`, the same watch link its card opens, so the watch page loads
 * and plays it as usual.
 */
export type QueuedStream = {
  queue_kind: "stream";
  /** The source URL: the entry's identity in the queue. */
  url: string;
  /** Where playing it goes, e.g. `/watch?url=…` (or `/watch/12` once downloaded). */
  href: string;
  title: string;
  channel: string | null;
  thumbnail: string | null;
  duration: number | null;
};

/** Library videos keep their stored shape, so queues saved earlier still load. */
export type QueueEntry = Video | QueuedStream;

export function isQueuedStream(entry: QueueEntry): entry is QueuedStream {
  return (entry as Partial<QueuedStream>).queue_kind === "stream";
}

/** A stable key for lists and removal: `v:<id>` or `s:<url>`. */
export function queueKey(entry: QueueEntry): string {
  return isQueuedStream(entry) ? `s:${entry.url}` : `v:${entry.id}`;
}

/** Drop what is about to play: the library video, and a stream entry linking to it. */
export function withoutVideo(queue: QueueEntry[], id: number): QueueEntry[] {
  return queue.filter((e) =>
    isQueuedStream(e) ? e.href !== `/watch/${id}` : e.id !== id
  );
}

export function withoutStream(queue: QueueEntry[], url: string): QueueEntry[] {
  return queue.filter((e) => !(isQueuedStream(e) && e.url === url));
}

export function withEntryAtEnd(
  queue: QueueEntry[],
  entry: QueueEntry
): QueueEntry[] {
  const key = queueKey(entry);
  return queue.some((e) => queueKey(e) === key) ? queue : [...queue, entry];
}

export function withEntryFirst(
  queue: QueueEntry[],
  entry: QueueEntry
): QueueEntry[] {
  const key = queueKey(entry);
  return [entry, ...queue.filter((e) => queueKey(e) !== key)];
}

export function withoutKey(queue: QueueEntry[], key: string): QueueEntry[] {
  return queue.filter((e) => queueKey(e) !== key);
}
