import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import {
  appendUnseenFeedEntries,
  excludeKnownYoutubeIds,
} from "../../components/channelFeedYoutubeSearch";
import { useDownloads } from "../../context/DownloadContext";
import { useSearch } from "../../context/SearchContext";
import { useToast } from "../../context/ToastContext";
import { extractYouTubeId } from "../../hooks/useSponsorBlock";
import type { ChannelFeedEntry, Video } from "../../types";
import { YOUTUBE_SEARCH_PAGE_SIZE } from "../libraryCatalogProgress";

/**
 * Results beyond the library for a home-page search: videos from indexed
 * channels that can be streamed, and (when switched on) a live YouTube search.
 */
export function useGlobalSearch(input: {
  debouncedSearch: string;
  activeChannel: string | null;
  /** Changes when the library is refreshed, to search again. */
  refreshKey: number;
  videos: Video[];
  otherVideos: Video[];
}) {
  const { debouncedSearch, activeChannel, refreshKey, videos, otherVideos } =
    input;
  const { search, committedQuery, youtubeVideoSearch, setYoutubeVideoSearch } =
    useSearch();
  const { showToast } = useToast();
  const { submitDownload } = useDownloads();

  const [streamResults, setStreamResults] = useState<ChannelFeedEntry[]>([]);
  const [streamLoading, setStreamLoading] = useState(false);
  const [streamDownloading, setStreamDownloading] = useState<Set<string>>(
    () => new Set()
  );
  const [youtubeResults, setYoutubeResults] = useState<ChannelFeedEntry[]>([]);
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  const [youtubeHasMore, setYoutubeHasMore] = useState(false);
  const [youtubeLoadingMore, setYoutubeLoadingMore] = useState(false);
  const youtubeMoreAcRef = useRef<AbortController | null>(null);
  const youtubeFetchOffsetRef = useRef(0);
  const [youtubeQuery, setYoutubeQuery] = useState("");

  useEffect(() => {
    const trimmed = search.trim();
    if (committedQuery === trimmed) {
      setYoutubeQuery(trimmed);
      return;
    }
    const id = setTimeout(() => setYoutubeQuery(trimmed), 800);
    return () => clearTimeout(id);
  }, [search, committedQuery]);

  // Global catalog search (home search only — channel pages use feed search).
  useEffect(() => {
    if (!debouncedSearch || activeChannel) {
      setStreamResults([]);
      setStreamLoading(false);
      return;
    }
    let cancelled = false;
    setStreamLoading(true);
    api
      .searchChannelCatalog({ q: debouncedSearch, limit: 40 })
      .then((page) => {
        if (!cancelled) setStreamResults(page.entries ?? []);
      })
      .catch(() => {
        if (!cancelled) setStreamResults([]);
      })
      .finally(() => {
        if (!cancelled) setStreamLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, activeChannel, refreshKey]);

  useEffect(() => {
    youtubeMoreAcRef.current?.abort();
    youtubeMoreAcRef.current = null;
    const q = youtubeQuery.trim();
    const live =
      youtubeVideoSearch &&
      !activeChannel &&
      q.length >= 2 &&
      q === search.trim();
    if (!live) {
      setYoutubeResults([]);
      setYoutubeHasMore(false);
      setYoutubeLoading(false);
      setYoutubeLoadingMore(false);
      youtubeFetchOffsetRef.current = 0;
      return;
    }
    const ac = new AbortController();
    setYoutubeResults([]);
    setYoutubeHasMore(false);
    setYoutubeLoading(true);
    setYoutubeLoadingMore(false);
    youtubeFetchOffsetRef.current = 0;
    api
      .searchYoutubeVideos({
        q,
        limit: YOUTUBE_SEARCH_PAGE_SIZE,
        signal: ac.signal,
      })
      .then((page) => {
        if (page.youtube_video_search_effective === false) {
          setYoutubeVideoSearch(false);
          setYoutubeResults([]);
          setYoutubeHasMore(false);
          return;
        }
        setYoutubeResults(page.entries ?? []);
        setYoutubeHasMore(Boolean(page.has_more));
        youtubeFetchOffsetRef.current = YOUTUBE_SEARCH_PAGE_SIZE;
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setYoutubeResults([]);
        setYoutubeHasMore(false);
      })
      .finally(() => {
        if (!ac.signal.aborted) setYoutubeLoading(false);
      });
    return () => {
      ac.abort();
      youtubeMoreAcRef.current?.abort();
    };
  }, [
    youtubeQuery,
    search,
    youtubeVideoSearch,
    setYoutubeVideoSearch,
    activeChannel,
    refreshKey,
  ]);

  const loadMoreYoutube = useCallback(() => {
    const q = youtubeQuery.trim();
    if (
      !youtubeVideoSearch ||
      activeChannel ||
      q.length < 2 ||
      q !== search.trim() ||
      youtubeLoading ||
      youtubeLoadingMore ||
      !youtubeHasMore
    ) {
      return;
    }
    youtubeMoreAcRef.current?.abort();
    const ac = new AbortController();
    youtubeMoreAcRef.current = ac;
    const offset = youtubeFetchOffsetRef.current;
    setYoutubeLoadingMore(true);
    api
      .searchYoutubeVideos({
        q,
        limit: YOUTUBE_SEARCH_PAGE_SIZE,
        offset,
        signal: ac.signal,
      })
      .then((page) => {
        const incoming = page.entries ?? [];
        setYoutubeResults((prev) => appendUnseenFeedEntries(prev, incoming));
        setYoutubeHasMore(Boolean(page.has_more));
        youtubeFetchOffsetRef.current = offset + YOUTUBE_SEARCH_PAGE_SIZE;
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setYoutubeHasMore(false);
      })
      .finally(() => {
        if (!ac.signal.aborted) setYoutubeLoadingMore(false);
      });
  }, [
    youtubeQuery,
    search,
    youtubeVideoSearch,
    activeChannel,
    youtubeLoading,
    youtubeLoadingMore,
    youtubeHasMore,
  ]);

  // YouTube hits that are already in the library or in the stream list are shown there.
  const youtubeVisible = useMemo(
    () =>
      excludeKnownYoutubeIds(youtubeResults, [
        ...streamResults.map((e) => e.id),
        ...videos.map((v) => extractYouTubeId(v.source_url, v.file_path)),
        ...otherVideos.map((v) => extractYouTubeId(v.source_url, v.file_path)),
      ]),
    [youtubeResults, streamResults, videos, otherVideos]
  );

  const queueRemoteDownload = (entry: ChannelFeedEntry) => {
    if (!entry.url || streamDownloading.has(entry.url)) return;
    const channelName = entry.channel || "Unknown channel";
    setStreamDownloading((prev) => new Set(prev).add(entry.url));
    void submitDownload(entry.url, "1080p", {
      title: entry.title ?? undefined,
      channel: channelName,
    })
      .then(() => showToast("Download queued"))
      .catch((err: unknown) =>
        showToast(
          err instanceof Error ? err.message : "Could not start download"
        )
      )
      .finally(() => {
        setStreamDownloading((prev) => {
          const next = new Set(prev);
          next.delete(entry.url);
          return next;
        });
      });
  };

  return {
    streamResults,
    streamLoading,
    streamDownloading,
    youtubeQuery,
    youtubeVisible,
    youtubeLoading,
    youtubeHasMore,
    youtubeLoadingMore,
    loadMoreYoutube,
    queueRemoteDownload,
  };
}
