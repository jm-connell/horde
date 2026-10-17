import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChatStreamOptions } from "../../api";
import { describeError } from "../../apiErrors";
import type { AiTarget } from "../../components/aiTarget";
import { useAuth } from "../../context/AuthContext";
import { usePlaybackActions } from "../../context/PlaybackContext";
import { useToast } from "../../context/ToastContext";
import { appSettingsQuery } from "../../queries/app";
import { queryKeys } from "../../queries/keys";
import { useStreamAi } from "../../queries/preview";
import { useAiStatus } from "../../queries/status";
import type { AiChaptersMode, StreamAi, Video } from "../../types";
import { chaptersFromApi, formatDate, parseChapters } from "../../utils";
import type { WatchSource } from "./useWatchVideo";

/**
 * Which AI features this install offers for the video on screen (summary,
 * chat, chapters), generating its chapters on demand, and the `AiTarget` the
 * AI panel works on. A streamed video keeps its results on the server for a
 * while (`/api/preview/ai`); they move onto the library video on download.
 */
export function useWatchAi(
  source: WatchSource | null,
  setVideo: (video: Video) => void
) {
  const { showError } = useToast();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const { setStreamChapters } = usePlaybackActions();
  const [chapterError, setChapterError] = useState<string | null>(null);
  const video = source?.kind === "library" ? source.video : null;
  const stream = source?.kind === "stream" ? source : null;
  const videoId = video?.id;
  const streamUrl = stream?.url ?? "";
  const isLibrary = video != null;
  const isStream = stream != null;
  const canUseAi = can("use_ai");

  // --- Which AI features this install offers ---
  const wantsFeatures = isLibrary || (isStream && canUseAi);
  const appSettings = useQuery({
    ...appSettingsQuery(),
    enabled: wantsFeatures,
  }).data;
  const aiStatus = useAiStatus({ enabled: wantsFeatures }).data;
  const streamAi = useStreamAi(streamUrl, isStream && canUseAi).data;
  const streamSupported = !!streamAi && streamAi.supported;
  const aiFeatures = useMemo(() => {
    if (!appSettings || !aiStatus) {
      return {
        summaries: false,
        chapters: false,
        chaptersMode: "on_download" as AiChaptersMode,
        chat: false,
        costs: false,
      };
    }
    const ai = appSettings.ai;
    const openRouterConnected =
      !!aiStatus.openrouter_enabled && !!aiStatus.openrouter_api_key_set;
    const localConnected = !!aiStatus.enabled && !!aiStatus.reachable;
    const llmConnected = openRouterConnected || localConnected;
    return {
      summaries: llmConnected && !!ai.ai_summaries,
      chapters: llmConnected && !!ai.ai_chapters,
      chaptersMode: (ai.ai_chapters_mode === "on_watch"
        ? "on_watch"
        : "on_download") as AiChaptersMode,
      chat: llmConnected && !!ai.ai_chat,
      costs: openRouterConnected && ai.openrouter_show_costs === true,
    };
  }, [appSettings, aiStatus]);
  const aiSummariesEnabled = aiFeatures.summaries;
  const aiChaptersEnabled = aiFeatures.chapters;
  const aiChaptersMode = aiFeatures.chaptersMode;
  const aiChatEnabled = aiFeatures.chat;
  const showAiCosts = aiFeatures.costs;

  useEffect(() => {
    setChapterError(null);
  }, [videoId, streamUrl]);

  // The video on screen, read by mutation callbacks that finish later: the
  // page is not remounted between videos, so a late result must be checked.
  const targetRef = useRef({ videoId, streamUrl });
  useEffect(() => {
    targetRef.current = { videoId, streamUrl };
  });

  const chaptersMutation = useMutation({
    mutationFn: ({ id, force }: { id: number; force: boolean }) =>
      api.generateVideoChapters(id, { force }),
    onMutate: () => {
      setChapterError(null);
    },
    onSuccess: (updated) => {
      if (updated.id === targetRef.current.videoId) setVideo(updated);
    },
    onError: (err, { id }) => {
      if (id !== targetRef.current.videoId) return;
      const msg = describeError(err) || "Could not generate chapters";
      setChapterError(msg);
      showError(msg);
    },
  });
  const streamChaptersMutation = useMutation({
    mutationFn: ({
      url,
      force,
      signal,
    }: {
      url: string;
      force: boolean;
      signal?: AbortSignal;
    }) => api.generateStreamChapters(url, { force, signal }),
    onMutate: () => {
      setChapterError(null);
    },
    onSuccess: (res: StreamAi, { url }) => {
      queryClient.setQueryData(queryKeys.preview.ai(url), res);
    },
    onError: (err, { url }) => {
      // The server may have stored an empty caption track or created the row.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.preview.ai(url),
      });
      if (url !== targetRef.current.streamUrl) return;
      const msg = describeError(err) || "Could not generate chapters";
      setChapterError(msg);
      showError(msg);
    },
  });
  const generatingChapters =
    (chaptersMutation.isPending &&
      chaptersMutation.variables?.id === videoId) ||
    (streamChaptersMutation.isPending &&
      streamChaptersMutation.variables?.url === streamUrl);
  const generateChapters = useCallback(
    async (force: boolean) => {
      if (video) {
        await chaptersMutation
          .mutateAsync({ id: video.id, force })
          .catch(() => {
            // reported by the mutation's onError
          });
      } else if (streamUrl) {
        await streamChaptersMutation
          .mutateAsync({ url: streamUrl, force })
          .catch(() => {
            // reported by the mutation's onError
          });
      }
    },
    [video, streamUrl, chaptersMutation, streamChaptersMutation]
  );

  // A stream's chapters: the description's, else the AI ones saved for it.
  const streamDescription = stream?.meta.description;
  const descriptionChapters = useMemo(
    () => (streamDescription ? parseChapters(streamDescription) : []),
    [streamDescription]
  );
  const savedAiChapters = streamAi?.chapters;
  const aiStreamChapters = useMemo(
    () => chaptersFromApi(savedAiChapters),
    [savedAiChapters]
  );
  const streamChapters = useMemo(
    () =>
      descriptionChapters.length > 0 ? descriptionChapters : aiStreamChapters,
    [descriptionChapters, aiStreamChapters]
  );
  // Hand them to the player (chapter markers) too.
  useEffect(() => {
    if (streamUrl) setStreamChapters(streamUrl, streamChapters);
  }, [streamUrl, streamChapters, setStreamChapters]);

  const hasSubtitles = stream
    ? stream.meta.subtitles.length > 0 && streamAi?.has_captions !== false
    : (video?.subtitles?.length ?? 0) > 0;
  const aiAvailable = isLibrary || (isStream && canUseAi && streamSupported);
  const canAiSummarize = aiAvailable && hasSubtitles && aiSummariesEnabled;
  const chaptersSource = video
    ? video.chapters_source
    : stream
      ? descriptionChapters.length > 0
        ? ("description" as const)
        : aiStreamChapters.length > 0
          ? ("ai" as const)
          : null
      : null;
  const hasAiChapters = chaptersSource === "ai";
  const chapterBusy =
    generatingChapters || !!(video && video.processing_chapters);
  const canGenerateChapters =
    aiAvailable &&
    aiChaptersEnabled &&
    hasSubtitles &&
    (chaptersSource == null || chaptersSource === "ai");
  // Nothing generates a stream's chapters on its own, so the button is
  // always offered there; for a download it follows the "when" setting.
  const showChapterGenerate =
    canGenerateChapters &&
    !hasAiChapters &&
    (isStream ||
      aiChaptersMode === "on_watch" ||
      chapterBusy ||
      !!chapterError);
  const showChapterActions =
    canGenerateChapters && (hasAiChapters || showChapterGenerate);
  const mediaTitle = video ? video.title : stream?.meta.title;
  const mediaDescription = video ? video.description : stream?.meta.description;
  const canAiChat =
    aiAvailable &&
    aiChatEnabled &&
    !!(
      (mediaTitle || "").trim() ||
      (mediaDescription || "").trim() ||
      hasSubtitles
    );
  const showAiSection = canAiSummarize || canAiChat;

  // --- The AI panel's view of the video ---
  const libraryChat = useMemo(
    () =>
      videoId == null
        ? null
        : {
            list: () => api.getVideoAiChat(videoId),
            clear: () => api.clearVideoAiChat(videoId),
            stream: (message: string, opts: ChatStreamOptions) =>
              api.streamVideoAiChat(videoId, message, opts),
          },
    [videoId]
  );
  const streamChat = useMemo(
    () =>
      !streamUrl
        ? null
        : {
            list: () => api.getStreamAiChat(streamUrl),
            clear: () => api.clearStreamAiChat(streamUrl),
            stream: async (message: string, opts: ChatStreamOptions) => {
              try {
                await api.streamStreamAiChat(streamUrl, message, opts);
              } finally {
                // A turn can create the saved row and push back its expiry.
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.preview.ai(streamUrl),
                });
              }
            },
          },
    [streamUrl, queryClient]
  );
  const summarizeLibrary = useCallback(
    async (force: boolean, signal: AbortSignal) => {
      if (videoId == null) return;
      setVideo(await api.summarizeVideo(videoId, { force, signal }));
    },
    [videoId, setVideo]
  );
  const summarizeStream = useCallback(
    async (force: boolean, signal: AbortSignal) => {
      if (!streamUrl) return;
      try {
        const res = await api.summarizeStream(streamUrl, { force, signal });
        queryClient.setQueryData(queryKeys.preview.ai(streamUrl), res);
      } catch (err) {
        // Refresh has_captions / expires_at, which a failed run may change.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.preview.ai(streamUrl),
        });
        throw err;
      }
    },
    [streamUrl, queryClient]
  );
  const aiSummary = video ? video.ai_summary : streamAi?.summary;
  const processingSummary = !!video?.processing_summary;
  const expiresAt = streamAi?.expires_at ?? null;
  const target = useMemo<AiTarget | null>(() => {
    if (videoId != null && libraryChat) {
      return {
        key: `video:${videoId}`,
        summary: aiSummary ?? null,
        processingSummary,
        hasSubtitles,
        summarize: summarizeLibrary,
        chat: libraryChat,
      };
    }
    if (streamUrl && streamChat) {
      const until = formatDate(expiresAt);
      return {
        key: `stream:${streamUrl}`,
        summary: aiSummary ?? null,
        processingSummary: false,
        hasSubtitles,
        note: until
          ? `Saved until ${until} \u2014 downloading the video keeps it.`
          : null,
        summarize: summarizeStream,
        chat: streamChat,
      };
    }
    return null;
  }, [
    videoId,
    libraryChat,
    streamUrl,
    streamChat,
    aiSummary,
    processingSummary,
    hasSubtitles,
    expiresAt,
    summarizeLibrary,
    summarizeStream,
  ]);

  return {
    target,
    streamChapters,
    canAiSummarize,
    canAiChat,
    showAiCosts,
    showAiSection,
    chaptersSource,
    hasAiChapters,
    chapterBusy,
    chapterError,
    showChapterGenerate,
    showChapterActions,
    generateChapters,
  };
}

export type WatchAi = ReturnType<typeof useWatchAi>;
