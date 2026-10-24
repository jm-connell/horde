import type { Video } from "../../types";
import type { StreamSession } from "../PlaybackContext";

/**
 * A fresh copy of the playing video's details. Its resume position is where
 * the player started; from then on the player owns the position, and a newer
 * saved one (a few seconds behind, from this very playback) would seek it
 * back. So the details change, the position does not.
 */
export function withPlayingPosition(playing: Video, fresh: Video): Video {
  return {
    ...playing,
    ...fresh,
    last_position_sec: playing.last_position_sec,
    last_watched_at: playing.last_watched_at,
  };
}

export function mimeFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    default:
      return "video/mp4";
  }
}

export function streamExpandPath(session: StreamSession): string {
  const qs = new URLSearchParams();
  qs.set("url", session.url);
  const channel = session.channelParam || session.channel;
  if (channel) qs.set("channel", channel);
  return `/watch?${qs.toString()}`;
}
