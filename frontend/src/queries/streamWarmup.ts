import { isCancelledError, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { StreamPreviewMeta } from "../types";
import { queryKeys } from "./keys";

/** How long the pointer (or keyboard focus) rests on a card before it warms. */
export const WARM_DWELL_MS = 120;
/** A video warmed this recently is not warmed again (the server's lookup cache). */
export const WARM_REPEAT_MS = 180_000;

export interface WarmDeps {
  fetchMeta(
    url: string
  ): Promise<Pick<StreamPreviewMeta, "is_live" | "library_video_id">>;
  fetchManifest(url: string): Promise<void>;
  now(): number;
}

/**
 * Loads a not-downloaded video's details and has the server build its manifest
 * before the click, so the watch page and the player find both ready.
 *
 * One warm-up runs at a time; while it runs, only the newest request waits and
 * older ones are dropped. A started warm-up is never cancelled: the server
 * would keep working on it anyway. Failures are ignored (the click loads as
 * usual) and wait out the same window: a video that cannot play (a premiere,
 * a private or removed video) would otherwise cost a YouTube lookup per hover.
 * Only a cancelled warm-up may be retried at once.
 */
export class StreamWarmer {
  private readonly deps: WarmDeps;
  private dwell: ReturnType<typeof setTimeout> | null = null;
  /** Who started the dwell: only they may cancel it (see ``leave``). */
  private dweller: unknown = undefined;
  private running: string | null = null;
  private pending: string | null = null;
  private readonly recent = new Map<string, number>();
  private settled: Promise<void> = Promise.resolve();

  constructor(deps: WarmDeps) {
    this.deps = deps;
  }

  /**
   * Warm ``url`` once the pointer or focus has rested on it long enough. It
   * replaces any other dwell; ``owner`` is who may cancel it with ``leave``.
   */
  rest(url: string, owner?: unknown): void {
    this.leave(this.dweller);
    this.dweller = owner;
    this.dwell = setTimeout(() => {
      this.dwell = null;
      this.warm(url);
    }, WARM_DWELL_MS);
  }

  /**
   * The pointer or focus moved off ``owner``'s card before the dwell ended. A
   * dwell another owner started stays: a card unmounting elsewhere (an
   * infinite list, a refreshed feed) must not cancel the one under the pointer.
   */
  leave(owner?: unknown): void {
    if (this.dwell == null || owner !== this.dweller) return;
    clearTimeout(this.dwell);
    this.dwell = null;
  }

  /** Warm ``url`` now (a mouse button went down on it). */
  warm(url: string): void {
    const now = this.deps.now();
    for (const [key, at] of this.recent) {
      if (now - at >= WARM_REPEAT_MS) this.recent.delete(key);
    }
    if (this.recent.has(url) || url === this.running || url === this.pending) {
      return;
    }
    if (this.running != null) {
      this.pending = url;
      return;
    }
    this.settled = this.run(url);
  }

  /** Settles once nothing is running or waiting. */
  async idle(): Promise<void> {
    let seen: Promise<void> | null = null;
    while (seen !== this.settled) {
      seen = this.settled;
      await seen;
    }
  }

  private async run(url: string): Promise<void> {
    this.running = url;
    this.recent.set(url, this.deps.now());
    try {
      const meta = await this.deps.fetchMeta(url);
      if (!meta.is_live && meta.library_video_id == null) {
        await this.deps.fetchManifest(url);
      }
    } catch (err) {
      // Best effort: the click loads it as usual.
      if (isCancelledError(err)) this.recent.delete(url);
    }
    this.running = null;
    const next = this.pending;
    this.pending = null;
    if (next != null) await this.run(next);
  }
}

const warmers = new WeakMap<QueryClient, StreamWarmer>();

/** The warmer for this app's query cache (one per client, so tests start clean). */
export function streamWarmer(client: QueryClient): StreamWarmer {
  let warmer = warmers.get(client);
  if (!warmer) {
    warmer = new StreamWarmer({
      fetchMeta: (url) =>
        client.fetchQuery({
          queryKey: queryKeys.preview.meta(url),
          queryFn: ({ signal }) => api.getPreviewMeta(url, { signal }),
          staleTime: WARM_REPEAT_MS,
        }),
      fetchManifest: (url) => api.warmPreviewManifest(url),
      now: () => Date.now(),
    });
    warmers.set(client, warmer);
  }
  return warmer;
}
