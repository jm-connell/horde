import { useCallback, useEffect, useRef, type RefObject } from "react";
import { api } from "../api";
import type { Video } from "../types";

/** Minimum gap between catch-up checks (focus and visibility fire together). */
const CATCH_UP_THROTTLE_MS = 3000;

/** The server ignores positions in a video's first seconds (update_progress). */
const SERVER_MIN_POSITION_SEC = 5;

/** The account's saved place in a video, as far as this device knows it. */
interface KnownPosition {
  videoId: number;
  positionSec: number;
}

/**
 * Whether the account's saved position is not the one this device last knew,
 * i.e. another device (or tab) of the account has saved since.
 */
export function movedElsewhere(knownSec: number, serverSec: number): boolean {
  return Math.abs(serverSec - knownSec) > 1;
}

/**
 * Keeps the player in step with the account's position on other devices.
 *
 * This device knows the account's position in the playing video: the one the
 * video was opened with, then each one it saved itself. A server position
 * that differs was saved elsewhere. So:
 * - opening the video that is already playing here (expanding the
 *   mini-player) keeps the playhead, unless another device moved on;
 * - when the tab or window comes back while the player is paused, a position
 *   saved on another device meanwhile is taken over (without starting
 *   playback).
 */
export function useAccountPosition({
  currentRef,
  streamPlayingRef,
  hostRef,
  livePositionRef,
}: {
  currentRef: RefObject<Video | null>;
  /** True while a stream preview, not a library video, is loaded. */
  streamPlayingRef: RefObject<boolean>;
  /** The element holding the player. */
  hostRef: RefObject<HTMLElement | null>;
  /** The playhead of the library video, as the player last reported it. */
  livePositionRef: { current: number };
}) {
  const known = useRef<KnownPosition | null>(null);

  /** This device saved `positionSec` for the signed-in account. */
  const noteSaved = useCallback((videoId: number, positionSec: number) => {
    if (positionSec === 0 || positionSec >= SERVER_MIN_POSITION_SEC) {
      known.current = { videoId, positionSec };
    }
  }, []);

  /**
   * Where to play `video` from, as it is opened. Its `last_position_sec` is
   * the account's saved position; for the video already playing here, the
   * playhead wins unless another device saved since.
   */
  const startPosition = useCallback(
    (video: Video): number => {
      const playing = currentRef.current;
      const was = known.current;
      known.current = {
        videoId: video.id,
        positionSec: video.last_position_sec,
      };
      if (
        playing?.id === video.id &&
        was?.videoId === video.id &&
        !movedElsewhere(was.positionSec, video.last_position_sec)
      ) {
        return livePositionRef.current;
      }
      return video.last_position_sec;
    },
    [currentRef, livePositionRef]
  );

  useEffect(() => {
    let last = 0;
    const catchUp = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < CATCH_UP_THROTTLE_MS) return;
      const playing = currentRef.current;
      // Device-only downloads (negative ids) have no server position.
      if (!playing || playing.id <= 0 || streamPlayingRef.current) return;
      const el = hostRef.current?.querySelector("video");
      if (!el || !el.paused || el.ended) return;
      last = now;
      const videoId = playing.id;
      api
        .getVideo(videoId)
        .then((fresh) => {
          // Started, switched or closed meanwhile: leave it alone.
          if (currentRef.current?.id !== videoId || !el.paused) return;
          if (!el.isConnected) return;
          const was = known.current;
          const reference =
            was?.videoId === videoId ? was.positionSec : el.currentTime;
          const target = fresh.last_position_sec;
          if (!movedElsewhere(reference, target)) return;
          known.current = { videoId, positionSec: target };
          if (!Number.isFinite(el.duration) || target >= el.duration) return;
          el.currentTime = target;
          livePositionRef.current = target;
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("focus", catchUp);
    return () => {
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("focus", catchUp);
    };
  }, [currentRef, streamPlayingRef, hostRef, livePositionRef]);

  return { noteSaved, startPosition };
}
