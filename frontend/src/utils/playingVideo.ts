import type { Video } from "../types";

/**
 * Apply a library refresh to the video currently playing.
 *
 * Keeps the resume point from when playback started. Background jobs republish
 * `last_position_sec` from the last throttled progress save, which lags the
 * playhead and would seek the player backward on every refresh.
 */
export function mergePlayingVideo(current: Video, update: Video): Video | null {
  if (current.id !== update.id) return null;
  return {
    ...current,
    ...update,
    last_position_sec: current.last_position_sec,
  };
}
