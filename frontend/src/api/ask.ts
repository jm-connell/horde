import type { HelpDataConsent } from "../hooks/settings/types";
import type { AskVideo } from "../components/helpChat";
import type {
  AskChannel,
  AskChannelList,
  AskChannelPreview,
  AskSearchHit,
  AskThread,
  AskThreadSummary,
} from "../types";
import {
  type ChatStreamOptions,
  type Page,
  postEventStream,
  type ReadOptions,
  request,
} from "./client";

/** A video as the server takes it: a library id, or a stream's URL. */
function videoRef(video: AskVideo | null | undefined) {
  return video ? { library_id: video.library_id, url: video.url } : null;
}

export const askApi = {
  askChannels(opts?: ReadOptions): Promise<AskChannelList> {
    return request<AskChannelList>("/api/ask/channels", opts);
  },

  /** Reads YouTube: name, upload count and whether it has past live streams. */
  previewAskChannel(
    url: string,
    opts?: ReadOptions
  ): Promise<AskChannelPreview> {
    return request<AskChannelPreview>(
      `/api/ask/channels/preview?url=${encodeURIComponent(url)}`,
      opts
    );
  },

  addAskChannel(url: string, includeStreams: boolean): Promise<AskChannel> {
    return request<AskChannel>("/api/ask/channels", {
      method: "POST",
      body: JSON.stringify({ url, include_streams: includeStreams }),
    });
  },

  setAskChannelStreams(
    id: number,
    includeStreams: boolean
  ): Promise<AskChannel> {
    return request<AskChannel>(`/api/ask/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ include_streams: includeStreams }),
    });
  },

  pauseAskChannel(id: number): Promise<AskChannel> {
    return request<AskChannel>(`/api/ask/channels/${id}/pause`, {
      method: "POST",
    });
  },

  resumeAskChannel(id: number): Promise<AskChannel> {
    return request<AskChannel>(`/api/ask/channels/${id}/resume`, {
      method: "POST",
    });
  },

  removeAskChannel(id: number): Promise<void> {
    return request<void>(`/api/ask/channels/${id}`, { method: "DELETE" });
  },

  /** One page of passages mentioning the query, best match first. */
  searchAsk(params: {
    q: string;
    channelIds?: number[];
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<Page<AskSearchHit>> {
    const qs = new URLSearchParams({ q: params.q });
    for (const id of params.channelIds ?? [])
      qs.append("channel_id", String(id));
    if (params.cursor) qs.set("cursor", params.cursor);
    if (params.limit) qs.set("limit", String(params.limit));
    return request<Page<AskSearchHit>>(
      `/api/ask/search?${qs.toString()}`,
      params.signal ? { signal: params.signal } : undefined
    );
  },

  /**
   * One Ask turn (SSE): from channels when the question names one or
   * `channelIds` says which, from `video` unless the question is about Horde
   * or a channel, from Horde otherwise (`answerFrom` forces Horde or the
   * video for this turn: "Ask … instead"). The server
   * saves the turn in `threadId` (a new conversation when null; see the
   * `thread` event).
   */
  streamAsk(
    message: string,
    params: {
      threadId: number | null;
      channelIds: number[];
      /** The page's Ask channel and watched video (see `useAskPageChannel`). */
      pageChannelId?: number | null;
      pageVideoId?: string | null;
      /** "Ask … instead": answer this turn from Horde, or from `video`. */
      answerFrom?: "horde" | "video" | null;
      /** The video the user picked. */
      video?: AskVideo | null;
      /** The watch page's video, when nothing is picked. */
      pageVideo?: AskVideo | null;
      page: string;
      dataConsent: HelpDataConsent;
    },
    opts: ChatStreamOptions
  ): Promise<void> {
    return postEventStream(
      "/api/ask/chat",
      {
        message,
        thread_id: params.threadId,
        channel_ids: params.channelIds,
        page_channel_id: params.pageChannelId ?? null,
        page_video_id: params.pageVideoId ?? null,
        answer_from: params.answerFrom ?? null,
        video: videoRef(params.video),
        page_video: videoRef(params.pageVideo),
        page: params.page,
        data_consent: params.dataConsent,
      },
      opts
    );
  },

  askThreads(opts?: ReadOptions): Promise<Page<AskThreadSummary>> {
    return request<Page<AskThreadSummary>>("/api/ask/threads?limit=50", opts);
  },

  askThread(id: number, opts?: ReadOptions): Promise<AskThread> {
    return request<AskThread>(`/api/ask/threads/${id}`, opts);
  },

  deleteAskThread(id: number): Promise<void> {
    return request<void>(`/api/ask/threads/${id}`, { method: "DELETE" });
  },
};
