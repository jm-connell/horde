import type { Video } from "../../types";

/** How far the user is into the video, 0–1, when they have started it. */
export function videoProgress(video: Video): number | undefined {
  if (!video.duration_sec || video.duration_sec <= 0) return undefined;
  if (video.last_position_sec <= 0) return undefined;
  return Math.min(1, video.last_position_sec / video.duration_sec);
}
