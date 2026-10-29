import { useEffect, useState } from "react";
import { api } from "../api";
import type { StreamWatchWrite } from "../types";

/** A stream counts as watched once this much of it played... */
export const STREAM_WATCH_MIN_SEC = 20;
/** ...and then reports how far it got at most this often. */
export const STREAM_WATCH_INTERVAL_MS = 30_000;

export interface WatchedStream {
  url: string;
  title: string;
  channel: string | null;
  channelUrl?: string | null;
  durationSec?: number | null;
  /** Live broadcasts are not recorded. */
  live?: boolean;
}

interface Pending {
  stream: WatchedStream;
  sec: number;
}

/**
 * Records how far the user got in streamed (not downloaded) videos, so
 * Recommended+ learns from them and leaves them out. Nothing is sent before
 * `STREAM_WATCH_MIN_SEC` (a stream opened and left says little), then at most
 * every `STREAM_WATCH_INTERVAL_MS`, on `flush` (page hidden, another stream)
 * and on `finish`.
 */
export class StreamWatchReporter {
  private pending: Pending | null = null;
  private lastSentAt = -Infinity;

  constructor(
    private send: (payload: StreamWatchWrite) => void,
    private now: () => number = () => Date.now()
  ) {}

  report(stream: WatchedStream, sec: number): void {
    if (stream.live) return;
    if (this.pending && this.pending.stream.url !== stream.url) {
      this.flush();
      this.lastSentAt = -Infinity;
    }
    this.pending = { stream, sec };
    if (
      sec >= STREAM_WATCH_MIN_SEC &&
      this.now() - this.lastSentAt >= STREAM_WATCH_INTERVAL_MS
    ) {
      this.flush();
    }
  }

  /** Send the position not sent yet, if it counts. */
  flush = (): void => {
    const p = this.pending;
    this.pending = null;
    if (!p || p.sec < STREAM_WATCH_MIN_SEC) return;
    this.lastSentAt = this.now();
    this.send(payload(p.stream, p.sec, false));
  };

  /** The stream played to its end. */
  finish(stream: WatchedStream): void {
    if (stream.live) return;
    const sec = this.pending?.stream.url === stream.url ? this.pending.sec : 0;
    this.pending = null;
    this.lastSentAt = this.now();
    this.send(payload(stream, Math.max(sec, stream.durationSec ?? 0), true));
  }
}

function payload(
  stream: WatchedStream,
  sec: number,
  finished: boolean
): StreamWatchWrite {
  return {
    url: stream.url,
    title: stream.title || null,
    channel: stream.channel,
    channel_url: stream.channelUrl ?? null,
    position_sec: Math.max(0, sec),
    duration_sec:
      stream.durationSec && stream.durationSec > 0 ? stream.durationSec : null,
    finished,
  };
}

/** The app's one reporter; flushes when the page is hidden or closed. */
export function useStreamWatchReporter(): StreamWatchReporter {
  const [reporter] = useState(
    () =>
      new StreamWatchReporter((body) => {
        void api.recordStreamWatch(body).catch(() => undefined);
      })
  );
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") reporter.flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", reporter.flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", reporter.flush);
      reporter.flush();
    };
  }, [reporter]);
  return reporter;
}
