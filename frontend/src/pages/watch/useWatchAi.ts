import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { describeError } from "../../apiErrors";
import { appSettingsQuery } from "../../queries/app";
import { useAiStatus } from "../../queries/status";
import { useToast } from "../../context/ToastContext";
import type { AiChaptersMode, Video } from "../../types";
import type { WatchSource } from "./useWatchVideo";

/**
 * Which AI features this install offers for the library video on screen
 * (summary, chat, chapters) and generating its chapters on demand.
 */
export function useWatchAi(
  source: WatchSource | null,
  setVideo: (video: Video) => void
) {
  const { showError } = useToast();
  const [chapterError, setChapterError] = useState<string | null>(null);
  const video = source?.kind === "library" ? source.video : null;
  const videoId = video?.id;
  const isLibrary = video != null;

  // --- Library-only: which AI features this install offers ---
  const isLibrarySource = isLibrary;
  const appSettings = useQuery({
    ...appSettingsQuery(),
    enabled: isLibrarySource,
  }).data;
  const aiStatus = useAiStatus({ enabled: isLibrarySource }).data;
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
  }, [videoId]);

  const chaptersMutation = useMutation({
    mutationFn: ({ id, force }: { id: number; force: boolean }) =>
      api.generateVideoChapters(id, { force }),
    onMutate: () => {
      setChapterError(null);
    },
    onSuccess: setVideo,
    onError: (err) => {
      const msg = describeError(err) || "Could not generate chapters";
      setChapterError(msg);
      showError(msg);
    },
  });
  const generatingChapters = chaptersMutation.isPending;
  const generateChapters = useCallback(
    async (force: boolean) => {
      if (!video) return;
      await chaptersMutation.mutateAsync({ id: video.id, force }).catch(() => {
        // reported by the mutation's onError
      });
    },
    [video, chaptersMutation]
  );

  const hasSubtitles = (video?.subtitles?.length ?? 0) > 0;
  const canAiSummarize = hasSubtitles && aiSummariesEnabled;
  const chaptersSource = video ? video.chapters_source : null;
  const hasAiChapters = chaptersSource === "ai";
  const chapterBusy =
    generatingChapters || !!(video && video.processing_chapters);
  const canGenerateChapters =
    isLibrary &&
    aiChaptersEnabled &&
    hasSubtitles &&
    (chaptersSource == null || chaptersSource === "ai");
  const showChapterGenerate =
    canGenerateChapters &&
    !hasAiChapters &&
    (aiChaptersMode === "on_watch" || chapterBusy || !!chapterError);
  const showChapterActions =
    canGenerateChapters && (hasAiChapters || showChapterGenerate);
  const canAiChat =
    isLibrary &&
    aiChatEnabled &&
    !!(
      (video?.title || "").trim() ||
      (video?.description || "").trim() ||
      hasSubtitles
    );
  const showAiSection = canAiSummarize || canAiChat;

  return {
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
