import type {
  AskChannel,
  AskChannelList,
  AskChannelPreview,
  AskSearchHit,
} from "../types";
import { type Page, type ReadOptions, request } from "./client";

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
};
