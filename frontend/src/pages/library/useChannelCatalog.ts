import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { isYoutubeChannelUrl } from "../../components/channelFeedYoutubeSearch";
import { useToast } from "../../context/ToastContext";
import {
  channelCatalogStatusQuery,
  useChannelCatalogStatus,
} from "../../queries/status";
import type { ChannelAutodownload } from "../../types";
import type { CatalogProgress } from "../libraryCatalogProgress";

/** Compare channel URLs without the tab suffix or a trailing slash. */
export function normalizeChannelUrl(url: string): string {
  return url
    .replace(/\/+$/, "")
    .replace(/\/(videos|shorts|streams|playlists|featured|about|search)$/i, "")
    .toLowerCase();
}

export type AutodownloadPayload = {
  enabled: boolean;
  previous_mode: ChannelAutodownload["previous_mode"];
  previous_count: number;
  quality_preset: string;
  include_completed_streams: boolean;
};

/**
 * Everything a channel page knows about its YouTube catalog: index progress,
 * the autodownload policy and the per-channel YouTube search preference.
 */
export function useChannelCatalog(
  activeChannel: string | null,
  activeChannelUrl: string | null
) {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const onChannelPage = Boolean(activeChannel);
  const [indexingChannel, setIndexingChannel] = useState(false);
  const [catalogProgress, setCatalogProgress] =
    useState<CatalogProgress | null>(null);
  const toastedCatalogErrorRef = useRef<string | null>(null);
  const catalogErrorSeededRef = useRef(false);
  const [autodownloadOpen, setAutodownloadOpen] = useState(false);
  const [autodownload, setAutodownload] = useState<ChannelAutodownload | null>(
    null
  );
  const [autodownloadSaving, setAutodownloadSaving] = useState(false);
  const [youtubePrefSaving, setYoutubePrefSaving] = useState(false);

  useEffect(() => {
    setAutodownloadOpen(false);
  }, [activeChannel]);

  useEffect(() => {
    if (
      !onChannelPage ||
      !activeChannelUrl ||
      !isYoutubeChannelUrl(activeChannelUrl)
    ) {
      setAutodownload(null);
      return;
    }
    let cancelled = false;
    api
      .getChannelAutodownload({
        channel: activeChannel ?? undefined,
        url: activeChannelUrl,
      })
      .then((row) => {
        if (!cancelled) setAutodownload(row);
      })
      .catch(() => {
        if (!cancelled) setAutodownload(null);
      });
    return () => {
      cancelled = true;
    };
  }, [onChannelPage, activeChannel, activeChannelUrl]);

  const catalogStatusQuery = useChannelCatalogStatus({
    enabled: onChannelPage && !!activeChannelUrl,
    interval: 5000,
  });
  const catalogStatus = catalogStatusQuery.data;

  useEffect(() => {
    if (!onChannelPage || !activeChannelUrl) {
      setCatalogProgress(null);
      toastedCatalogErrorRef.current = null;
      catalogErrorSeededRef.current = false;
      return;
    }
    if (!catalogStatus) return;
    const status = catalogStatus;

    const target = normalizeChannelUrl(activeChannelUrl);
    const hit =
      status.catalogs.find(
        (c) => normalizeChannelUrl(c.channel_url) === target
      ) ?? null;
    const isCurrentJob =
      status.running &&
      status.current_channel_url != null &&
      normalizeChannelUrl(status.current_channel_url) === target;
    const maxVideos = hit?.max_videos || 1000;
    const lastError = hit?.last_error ?? null;
    if (!catalogErrorSeededRef.current) {
      catalogErrorSeededRef.current = true;
      toastedCatalogErrorRef.current = lastError;
    } else if (lastError && lastError !== toastedCatalogErrorRef.current) {
      toastedCatalogErrorRef.current = lastError;
      showToast(lastError);
    } else if (!lastError) {
      toastedCatalogErrorRef.current = null;
    }
    if (!hit) {
      const system = status.direct_youtube_search ?? true;
      setCatalogProgress({
        indexed: isCurrentJob ? status.done : 0,
        total: null,
        maxVideos,
        complete: false,
        status: null,
        indexing: isCurrentJob,
        lastError,
        youtubeSearchOverride: null,
        youtubeSearchEffective: system,
        youtubeSearchSystem: system,
      });
      return;
    }
    const indexing =
      hit.status === "queued" || hit.status === "indexing" || isCurrentJob;
    // While the flat list is still growing, prefer live done count.
    const indexed =
      isCurrentJob && status.current_phase === "flat" && status.done > 0
        ? status.done
        : hit.indexed_count;
    setCatalogProgress({
      indexed,
      total: hit.channel_total,
      maxVideos,
      complete: hit.complete && !indexing,
      status: hit.status,
      indexing,
      lastError,
      youtubeSearchOverride: hit.direct_youtube_search ?? null,
      youtubeSearchEffective:
        hit.direct_youtube_search_effective ??
        status.direct_youtube_search ??
        true,
      youtubeSearchSystem: status.direct_youtube_search ?? true,
    });
  }, [onChannelPage, activeChannelUrl, catalogStatus, showToast]);

  const triggerChannelIndex = async () => {
    if (!activeChannel || indexingChannel) return;
    if (!activeChannelUrl) {
      showToast("No YouTube URL known for this channel yet");
      return;
    }
    setIndexingChannel(true);
    try {
      const result = await api.indexChannelCatalog({
        channel: activeChannel,
        url: activeChannelUrl,
        force: true,
      });
      showToast(result.detail || "Channel indexing queued");
      // Refresh progress immediately so the status line updates.
      queryClient
        .fetchQuery({ ...channelCatalogStatusQuery(), staleTime: 0 })
        .then((status) => {
          if (!activeChannelUrl) return;
          const target = normalizeChannelUrl(activeChannelUrl);
          const hit = status.catalogs.find(
            (c) => normalizeChannelUrl(c.channel_url) === target
          );
          setCatalogProgress((prev) => ({
            indexed: hit?.indexed_count ?? 0,
            total: hit?.channel_total ?? null,
            maxVideos: hit?.max_videos || 1000,
            complete: false,
            status: hit?.status ?? "queued",
            indexing: true,
            lastError: hit?.last_error ?? null,
            youtubeSearchOverride:
              hit?.direct_youtube_search ?? prev?.youtubeSearchOverride ?? null,
            youtubeSearchEffective:
              hit?.direct_youtube_search_effective ??
              prev?.youtubeSearchEffective ??
              true,
            youtubeSearchSystem:
              status.direct_youtube_search ?? prev?.youtubeSearchSystem ?? true,
          }));
        })
        .catch(() => undefined);
    } catch (err) {
      showToast(
        err instanceof Error && err.message
          ? err.message
          : "Could not start channel indexing"
      );
    } finally {
      setIndexingChannel(false);
    }
  };

  const saveAutodownload = async (payload: AutodownloadPayload) => {
    if (!activeChannelUrl) {
      showToast("No YouTube URL known for this channel yet");
      return;
    }
    setAutodownloadSaving(true);
    try {
      const row = await api.updateChannelAutodownload({
        channel: activeChannel ?? undefined,
        url: activeChannelUrl,
        ...payload,
      });
      setAutodownload(row);
      setAutodownloadOpen(false);
      showToast(
        payload.enabled ? "Autodownload saved" : "Autodownload turned off"
      );
    } catch (err) {
      showToast(
        err instanceof Error && err.message
          ? err.message
          : "Could not save autodownload"
      );
    } finally {
      setAutodownloadSaving(false);
    }
  };

  const setChannelYoutubeSearch = async (value: boolean | null) => {
    if (!activeChannelUrl || youtubePrefSaving) return;
    setYoutubePrefSaving(true);
    try {
      const result = await api.updateChannelYoutubeSearch({
        channel: activeChannel ?? undefined,
        url: activeChannelUrl,
        direct_youtube_search: value,
      });
      setCatalogProgress((prev) =>
        prev
          ? {
              ...prev,
              youtubeSearchOverride: result.direct_youtube_search,
              youtubeSearchEffective: result.direct_youtube_search_effective,
            }
          : prev
      );
    } catch (err) {
      showToast(
        err instanceof Error && err.message
          ? err.message
          : "Could not update YouTube search"
      );
    } finally {
      setYoutubePrefSaving(false);
    }
  };

  return {
    catalogProgress,
    indexingChannel,
    triggerChannelIndex,
    autodownload,
    autodownloadOpen,
    setAutodownloadOpen,
    autodownloadSaving,
    saveAutodownload,
    youtubePrefSaving,
    setChannelYoutubeSearch,
  };
}
