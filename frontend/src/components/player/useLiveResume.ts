import {
  useEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";

/**
 * Away this long with the page hidden (screen off, app in the background),
 * a live stream reconnects instead of trusting its stale playlists: the server
 * may have closed the session and the browser stopped refreshing them.
 */
export const LIVE_RESUME_AFTER_MS = 60_000;
/** A pause this close to the page hiding was the system's (iOS on lock). */
const SYSTEM_PAUSE_MS = 1500;

/**
 * Where the playhead goes after reconnecting: as far behind live as it was
 * left, plus the time away (as if it had stayed paused in the live timeline),
 * inside the seekable window.
 */
export function liveResumeTime(
  range: { start: number; end: number },
  behindSec: number
): number {
  return Math.min(range.end, Math.max(range.start, range.end - behindSec));
}

interface Left {
  at: number;
  /** Seconds behind the live edge when left. */
  behind: number;
  /** It was playing when the page hid (or the system paused it on the way). */
  resume: boolean;
  /** The page was hidden at some point since. */
  hidden: boolean;
}

/**
 * Picks a live stream back up after the viewer was away. On return to a stream
 * that was playing, or on Play after a pause that spanned time hidden, it
 * reloads the stream (`reconnect`) and seeks to where it was left in the live
 * timeline. A stream that kept playing in a background tab is left alone.
 */
export function useLiveResume({
  enabled,
  videoRef,
  shakaPlayerRef,
  shakaReady,
  reconnect,
}: {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  shakaPlayerRef: MutableRefObject<ShakaPlayer | null>;
  shakaReady: boolean;
  /** Reload the stream (a new Shaka load of the same source). */
  reconnect: () => void;
}): void {
  const behindTargetRef = useRef<number | null>(null);
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  useEffect(() => {
    if (!enabled) return;
    const video = videoRef.current;
    if (!video) return;
    let left: Left | null = null;
    let hiddenAt: number | null = null;

    const behindNow = () => {
      try {
        const end = shakaPlayerRef.current?.seekRange().end;
        return end != null && Number.isFinite(end)
          ? Math.max(0, end - video.currentTime)
          : 0;
      } catch {
        return 0; // The player may be mid-destroy.
      }
    };
    const pickUp = (l: Left) => {
      left = null;
      behindTargetRef.current = l.behind + (Date.now() - l.at) / 1000;
      reconnectRef.current();
    };

    const onPause = () => {
      const now = Date.now();
      // Paused while hidden but still playing (a background tab, picture in
      // picture): the viewer's pause, which Play decides on.
      if (left && hiddenAt != null && now - hiddenAt >= SYSTEM_PAUSE_MS) {
        left = { at: now, behind: behindNow(), resume: false, hidden: true };
        return;
      }
      if (left) return;
      left = {
        at: now,
        behind: behindNow(),
        // Paused just after the page hid: the system's doing, not the viewer's.
        resume: hiddenAt != null && now - hiddenAt < SYSTEM_PAUSE_MS,
        hidden: hiddenAt != null,
      };
    };
    const onPlay = () => {
      const l = left;
      if (l && l.hidden && Date.now() - l.at >= LIVE_RESUME_AFTER_MS) pickUp(l);
      else left = null;
    };
    const onVisibility = () => {
      const now = Date.now();
      if (document.visibilityState === "hidden") {
        hiddenAt = now;
        if (!video.paused) {
          left = { at: now, behind: behindNow(), resume: true, hidden: true };
        } else if (left) {
          left.hidden = true;
          // Paused just before the page hid: the system's doing too.
          if (now - left.at < SYSTEM_PAUSE_MS) left.resume = true;
        }
        return;
      }
      hiddenAt = null;
      const l = left;
      if (!l?.resume || !video.paused) {
        // Kept playing (a background tab), or paused by the viewer: Play decides.
        if (l && !video.paused) left = null;
        return;
      }
      if (now - l.at >= LIVE_RESUME_AFTER_MS) pickUp(l);
      else {
        left = null;
        video.play().catch(() => undefined);
      }
    };

    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      video.removeEventListener("pause", onPause);
      video.removeEventListener("play", onPlay);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, videoRef, shakaPlayerRef]);

  // Once the reloaded stream is ready, go back to where it was left.
  useEffect(() => {
    const behind = behindTargetRef.current;
    const p = shakaPlayerRef.current;
    const video = videoRef.current;
    if (!shakaReady || behind == null || !p || !video) return;
    behindTargetRef.current = null;
    try {
      video.currentTime = liveResumeTime(p.seekRange(), behind);
    } catch (err) {
      console.warn("[live] could not return to where the stream was left", err);
    }
    video.play().catch(() => undefined);
  }, [shakaReady, shakaPlayerRef, videoRef]);
}
