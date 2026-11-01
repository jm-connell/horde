import type { LiveComments, VideoComments } from "../types";
import { type ReadOptions, request } from "./client";

export const commentsApi = {
  /** The comments saved with a library video. */
  videoComments(videoId: number, opts?: ReadOptions): Promise<VideoComments> {
    return request<VideoComments>(`/api/videos/${videoId}/comments`, opts);
  },

  /** Fetch and save a library video's top comments now (Edit details). */
  refreshVideoComments(videoId: number): Promise<VideoComments> {
    return request<VideoComments>(`/api/videos/${videoId}/comments/refresh`, {
      method: "POST",
    });
  },

  /** The top `limit` (100, 300 or 1000) comments, read from YouTube now. */
  liveComments(
    youtubeId: string,
    limit: number,
    opts?: ReadOptions
  ): Promise<LiveComments> {
    return request<LiveComments>(
      `/api/comments/youtube/${encodeURIComponent(youtubeId)}?limit=${limit}`,
      opts
    );
  },
};
