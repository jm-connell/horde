import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "../context/AuthContext";
import { describeError } from "../apiErrors";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, thumbnailUrl } from "../api";
import { appSettingsQuery } from "../queries/app";
import { useAiStatus } from "../queries/status";
import { useRelatedVideos } from "../queries/videos";
import StreamDownloadControl from "./watch/StreamDownloadControl";
import RedownloadDialog from "./watch/RedownloadDialog";
import WatchActions from "./watch/WatchActions";
import { useWatchActions } from "./watch/useWatchActions";
import { useStreamDownload } from "./watch/useStreamDownload";
import { useWatchVideo } from "./watch/useWatchVideo";
import LoadingIndicator from "../components/LoadingIndicator";
import PlaybackQueue from "../components/PlaybackQueue";
import { VideoAiPanel } from "../components/lazy";
import VideoCard from "../components/VideoCard";
import WatchMeta from "../components/WatchMeta";
import {
  usePlaybackActions,
  usePlaybackLayout,
  usePlaybackSession,
} from "../context/PlaybackContext";
import { useToast } from "../context/ToastContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSettings } from "../hooks/useSettings";
import type { AiChaptersMode } from "../types";
import {
  formatDate,
  formatDuration,
  formatResolution,
  formatSize,
  formatViewCount,
  parseChapters,
  resolveLibraryChapters,
  stripChapterLines,
  watchProcessingLabel,
} from "../utils";

export default function Watch() {
  const { can } = useAuth();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const libraryId = id ? Number(id) : NaN;
  const streamUrlParam = (searchParams.get("url") || "").trim();
  const channelParam = (searchParams.get("channel") || "").trim();

  const relatedSentinelRef = useRef<HTMLDivElement>(null);
  const [settings] = useSettings();
  const [chapterError, setChapterError] = useState<string | null>(null);

  const { showToast, showError } = useToast();
  const isMobile = useIsMobile();
  const { mode, queue } = usePlaybackSession();
  const { activeStreamQuality } = usePlaybackLayout();
  const { registerDock } = usePlaybackActions();

  const dockRef = useRef<HTMLDivElement>(null);

  const libraryValid = Number.isFinite(libraryId) && libraryId !== 0;
  const { source, setSource, loading, error, setVideo } = useWatchVideo({
    libraryId,
    libraryValid,
    streamUrlParam,
    channelParam,
  });

  const streamDownload = useStreamDownload({
    source,
    setSource,
    streamUrlParam,
    libraryValid,
    channelParam,
  });

  const actions = useWatchActions({
    video: source?.kind === "library" ? source.video : null,
    setSource,
  });

  // --- Library-only: which AI features this install offers ---
  const isLibrarySource = source?.kind === "library";
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

  const video = source?.kind === "library" ? source.video : null;
  const videoId = video?.id;

  useEffect(() => {
    setChapterError(null);
  }, [videoId]);

  const {
    videos: moreLikeThis,
    hasMore: relatedHasMore,
    loadingMore: relatedLoading,
    loadMore: loadMoreRelated,
  } = useRelatedVideos(videoId);

  useEffect(() => {
    if (!relatedHasMore) return;
    const el = relatedSentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRelated();
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [relatedHasMore, loadMoreRelated]);

  useEffect(() => {
    if (!source) return;
    registerDock(dockRef.current);
    return () => registerDock(null);
    // Do not depend on mode — re-registering on theater toggle briefly clears
    // the dock and can collapse the player into mini layout.
  }, [registerDock, source]);

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

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoadingIndicator label="Loading…" />
      </div>
    );
  }

  if (error || !source) {
    const backHref = channelParam
      ? `/?channel=${encodeURIComponent(channelParam)}`
      : "/";
    return (
      <div className="mx-auto max-w-lg space-y-4 py-16 text-center">
        <p className="text-gray-300">{error || "Video unavailable"}</p>
        <Link to={backHref} className="text-sm text-accent hover:underline">
          ← Back
        </Link>
      </div>
    );
  }

  const isLibrary = source.kind === "library";
  const isWide = !isMobile && mode === "theater";
  const showRelatedRight =
    isLibrary &&
    !isMobile &&
    mode === "standard" &&
    settings.showRelatedVideos &&
    moreLikeThis.length > 0;

  const title = isLibrary
    ? source.video.title
    : source.meta.title || "Untitled";
  const channelName = isLibrary
    ? source.video.channel
    : source.meta.channel || channelParam;
  const description = isLibrary
    ? source.video.description
    : source.meta.description;
  const chapters = isLibrary
    ? resolveLibraryChapters(source.video)
    : parseChapters(description);
  const descriptionBody = stripChapterLines(description);
  const queueVisible = isLibrary && queue.length > 0;

  // Live track quality for streams; file height for library.
  const resolution = isLibrary
    ? formatResolution(source.video.height_px)
    : formatResolution(activeStreamQuality);
  const processingLabel = isLibrary ? watchProcessingLabel(source.video) : null;

  const contentClass = showRelatedRight
    ? "mx-auto max-w-[90rem] 2xl:max-w-[116rem]"
    : "mx-auto max-w-5xl xl:max-w-6xl 2xl:max-w-[116rem]";

  const playerOuterClass = isMobile
    ? "relative left-1/2 w-screen -translate-x-1/2 bg-black"
    : `relative left-1/2 -translate-x-1/2 bg-black transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
        isWide ? "w-screen" : "w-full"
      }`;
  const playerInnerClass = isWide && !isMobile ? "mx-auto w-full" : "w-full";
  const playerMetaClass =
    "transition-[padding] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none" +
    (isWide ? " px-3 md:px-6" : "");

  const channelHref = channelName
    ? `/?channel=${encodeURIComponent(channelName)}`
    : "/";
  const backHref = channelParam
    ? `/?channel=${encodeURIComponent(channelParam)}`
    : "/";

  const hasSubtitles = isLibrary && (source.video.subtitles?.length ?? 0) > 0;
  const canAiSummarize = hasSubtitles && aiSummariesEnabled;
  const chaptersSource = isLibrary ? source.video.chapters_source : null;
  const hasAiChapters = chaptersSource === "ai";
  const chapterBusy =
    generatingChapters || !!(isLibrary && source.video.processing_chapters);
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
      (source.video.title || "").trim() ||
      (source.video.description || "").trim() ||
      hasSubtitles
    );
  const showAiSection = canAiSummarize || canAiChat;

  const relatedList = isLibrary ? (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        More like this
      </h3>
      <div className="space-y-2">
        {moreLikeThis.map((v) => {
          const thumb = thumbnailUrl(v);
          return (
            <Link
              key={v.id}
              to={`/watch/${v.id}`}
              className="group flex gap-2 rounded-lg p-1 transition-colors hover:bg-ink-800"
            >
              <div className="aspect-video w-40 shrink-0 overflow-hidden rounded-lg bg-ink-800">
                {thumb ? (
                  <img
                    decoding="async"
                    width={160}
                    height={90}
                    src={thumb}
                    alt={v.title}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted">
                    <span className="text-xl">▶</span>
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 py-0.5">
                <p className="line-clamp-2 text-sm font-medium text-gray-200 group-hover:text-accent">
                  {v.title}
                </p>
                {v.channel && (
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {v.channel}
                  </p>
                )}
                {v.duration_sec != null && (
                  <p className="mt-0.5 text-xs text-muted">
                    {formatDuration(v.duration_sec)}
                  </p>
                )}
              </div>
            </Link>
          );
        })}
      </div>
      <div ref={relatedSentinelRef} className="h-2" />
      {relatedLoading && <p className="text-xs text-muted">Loading more…</p>}
    </div>
  ) : null;

  return (
    <div
      className={`${contentClass} transition-[margin-top] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${isWide ? "-mt-6" : "mt-0"}`}
    >
      <div
        className={
          showRelatedRight
            ? "grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]"
            : undefined
        }
      >
        <div className="min-w-0">
          <div className={playerOuterClass}>
            <div className={playerInnerClass}>
              <div ref={dockRef} className="w-full" />
            </div>
          </div>

          <div className={playerMetaClass}>
            {isLibrary &&
              source.video.title_is_custom &&
              source.video.source_title &&
              source.video.source_title !== source.video.title && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink-800 px-4 py-3 ring-1 ring-ink-600">
                  <p className="text-sm text-gray-300">
                    Source title changed:{" "}
                    <span className="text-gray-400 line-through">
                      {source.video.title}
                    </span>{" "}
                    →{" "}
                    <span className="text-gray-200">
                      {source.video.source_title}
                    </span>
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        const updated = await api
                          .updateVideo(source.video.id, {
                            title: source.video.source_title!,
                            title_is_custom: false,
                          })
                          .catch((err) => {
                            showError(`Could not save: ${describeError(err)}`);
                            return null;
                          });
                        if (updated) setVideo(updated);
                      }}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink-950 hover:bg-accent-soft"
                    >
                      Use source
                    </button>
                    <button
                      onClick={async () => {
                        const updated = await api
                          .updateVideo(source.video.id, {
                            title: source.video.title,
                            title_is_custom: true,
                          })
                          .catch((err) => {
                            showError(`Could not save: ${describeError(err)}`);
                            return null;
                          });
                        if (updated) setVideo(updated);
                      }}
                      className="rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-ink-600"
                    >
                      Keep mine
                    </button>
                  </div>
                </div>
              )}

            {isLibrary &&
              source.video.description_is_custom &&
              source.video.source_description != null &&
              source.video.source_description !==
                (source.video.description ?? "") && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink-800 px-4 py-3 ring-1 ring-ink-600">
                  <p className="text-sm text-gray-300">
                    Source description changed while your custom description is
                    kept.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        const updated = await api
                          .updateVideo(source.video.id, {
                            description:
                              source.video.source_description ?? undefined,
                            description_is_custom: false,
                          })
                          .catch((err) => {
                            showError(`Could not save: ${describeError(err)}`);
                            return null;
                          });
                        if (updated) setVideo(updated);
                      }}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink-950 hover:bg-accent-soft"
                    >
                      Use source
                    </button>
                    <button
                      onClick={async () => {
                        const updated = await api
                          .updateVideo(source.video.id, {
                            description: source.video.description ?? undefined,
                            description_is_custom: true,
                          })
                          .catch((err) => {
                            showError(`Could not save: ${describeError(err)}`);
                            return null;
                          });
                        if (updated) setVideo(updated);
                      }}
                      className="rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-ink-600"
                    >
                      Keep mine
                    </button>
                  </div>
                </div>
              )}

            <div className="mt-5 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-bold text-gray-100">{title}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-gray-400">
                  {channelName && (
                    <Link
                      to={channelHref}
                      className="font-medium text-accent hover:underline"
                    >
                      {channelName}
                    </Link>
                  )}
                  {isLibrary && source.video.published_at && (
                    <span>{formatDate(source.video.published_at)}</span>
                  )}
                  {isLibrary && (
                    <span>{formatSize(source.video.file_size)}</span>
                  )}
                  {!isLibrary && source.meta.duration != null && (
                    <span>{formatDuration(source.meta.duration)}</span>
                  )}
                  {!isLibrary && source.meta.view_count != null && (
                    <span>{formatViewCount(source.meta.view_count)}</span>
                  )}
                  {resolution && (
                    <span className="text-xs text-muted">{resolution}</span>
                  )}
                  {processingLabel && (
                    <span
                      className="inline-flex items-center gap-0.5 text-[11px] text-muted"
                      role="status"
                      aria-live="polite"
                    >
                      processing {processingLabel}
                      <span className="horde-processing-ellipsis" aria-hidden>
                        …
                      </span>
                    </span>
                  )}
                  {isLibrary &&
                    source.video.frame_rate &&
                    source.video.frame_rate > 60 && (
                      <span className="text-xs text-muted">
                        {Math.round(source.video.frame_rate)}fps
                      </span>
                    )}
                  {!isLibrary && (
                    <StreamDownloadControl download={streamDownload} />
                  )}
                </div>
              </div>
              {!isLibrary && (
                <Link
                  to={backHref}
                  className="shrink-0 text-sm text-gray-400 hover:text-accent"
                >
                  ← Back
                </Link>
              )}
            </div>

            <div
              className={
                !showRelatedRight && queueVisible
                  ? "mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]"
                  : "mt-4 space-y-4"
              }
            >
              <div className="min-w-0 space-y-4">
                {isLibrary && showAiSection && can("use_ai") && (
                  <Suspense fallback={<LoadingIndicator className="py-4" />}>
                    <VideoAiPanel
                      video={source.video}
                      canSummarize={canAiSummarize}
                      canChat={canAiChat}
                      showCosts={showAiCosts}
                      onVideoUpdate={setVideo}
                      showToast={showToast}
                    />
                  </Suspense>
                )}

                <WatchMeta
                  description={descriptionBody}
                  chapters={chapters}
                  queueVisible={queueVisible}
                  notes={isLibrary ? source.video.notes : null}
                  tags={isLibrary ? source.video.tags : []}
                  aiTags={isLibrary ? source.video.ai_tags : []}
                  userTags={isLibrary ? source.video.user_tags : []}
                  chaptersSource={chaptersSource}
                  chapterGenerate={
                    showChapterActions
                      ? {
                          generating: chapterBusy,
                          hasExisting: hasAiChapters,
                          showGenerate: showChapterGenerate,
                          onGenerate: (force) => void generateChapters(force),
                          error: chapterError,
                        }
                      : null
                  }
                  onAddTag={
                    isLibrary
                      ? async (cleaned) => {
                          const updated = await api.updateVideo(
                            source.video.id,
                            {
                              tags: [...(source.video.tags || []), cleaned],
                              user_tag: cleaned,
                            }
                          );
                          setVideo(updated);
                        }
                      : undefined
                  }
                  onRemoveTag={
                    isLibrary
                      ? async (tag) => {
                          const next = (source.video.tags || []).filter(
                            (t) => t.toLowerCase() !== tag.toLowerCase()
                          );
                          const updated = await api.updateVideo(
                            source.video.id,
                            { tags: next }
                          );
                          setVideo(updated);
                        }
                      : undefined
                  }
                  onTagError={(msg) => showToast(msg)}
                />
              </div>

              {!showRelatedRight && queueVisible && (
                <PlaybackQueue className="lg:sticky lg:top-20 lg:self-start" />
              )}
            </div>

            {isLibrary && (
              <WatchActions
                video={source.video}
                actions={actions}
                isMobile={isMobile}
                onVideoUpdated={setVideo}
              />
            )}

            {isLibrary && !showRelatedRight && moreLikeThis.length > 0 && (
              <div className="mt-6">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  More like this
                </h3>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {moreLikeThis.map((v) => (
                    <VideoCard key={v.id} video={v} />
                  ))}
                </div>
                <div ref={relatedSentinelRef} className="h-4" />
                {relatedLoading && <LoadingIndicator />}
              </div>
            )}
          </div>
        </div>

        {showRelatedRight && (
          <aside className="hidden space-y-6 xl:block">
            {queue.length > 0 && <PlaybackQueue className="sticky top-20" />}
            <div className={queue.length > 0 ? "" : "sticky top-20"}>
              {relatedList}
            </div>
          </aside>
        )}
      </div>

      {isLibrary && <RedownloadDialog video={source.video} actions={actions} />}
    </div>
  );
}
