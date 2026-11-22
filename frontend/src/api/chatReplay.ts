import type { ChatReplayPage } from "../types";
import { type ReadOptions, request } from "./client";

const base = (youtubeId: string) =>
  `/api/chat-replay/youtube/${encodeURIComponent(youtubeId)}`;

export const chatReplayApi = {
  /** A past stream's chat around `atMs`, read from YouTube now (not saved). */
  chatReplayAt(
    youtubeId: string,
    atMs: number,
    opts?: ReadOptions
  ): Promise<ChatReplayPage> {
    return request<ChatReplayPage>(
      `${base(youtubeId)}?at_ms=${Math.max(0, Math.floor(atMs))}`,
      opts
    );
  },

  /** The stretch after an earlier page's `next_cursor`. */
  chatReplayNext(
    youtubeId: string,
    cursor: string,
    opts?: ReadOptions
  ): Promise<ChatReplayPage> {
    return request<ChatReplayPage>(
      `${base(youtubeId)}?cursor=${encodeURIComponent(cursor)}`,
      opts
    );
  },
};
