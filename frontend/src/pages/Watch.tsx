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
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, thumbnailUrl } from "../api";
import { usePresets } from "../queries/app";
import { queryKeys } from "../queries/keys";
import { useAiStatus } from "../queries/status";
import {
  replaceVideoInLists,
  useRelatedVideos,
  videoDetailQuery,
} from "../queries/videos";
import AddToPlaylist from "../components/AddToPlaylist";
import { useFocusTrap } from "../hooks/useFocusTrap";
import LoadingIndicator from "../components/LoadingIndicator";
import { MenuFlyout, MenuScroll } from "../components/MenuFlyout";
import PlaybackQueue from "../components/PlaybackQueue";
import ThemedSelect from "../components/ThemedSelect";
import OfflineDownloadButton from "../components/OfflineDownloadButton";
import VideoActionsMenu from "../components/VideoActionsMenu";
import { VideoAiPanel } from "../components/lazy";
import VideoCard from "../components/VideoCard";
import VideoEditForm from "../components/VideoEditForm";
import WatchMeta from "../components/WatchMeta";
import { isActiveJob, useDownloads } from "../context/DownloadContext";
import {
  usePlaybackActions,
  usePlaybackLayout,
  usePlaybackSession,
} from "../context/PlaybackContext";
import { useConfirm } from "../context/ConfirmContext";
import { useToast } from "../context/ToastContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSettings } from "../hooks/useSettings";
import {
  PRESET_ORDER,
  presetOptionLabel,
  resolveQualityPreset,
} from "../presets";
import type { StreamPreviewMeta, Video, AiChaptersMode } from "../types";
import {
  downloadProcessingLabel,
  downloadProgressPercent,
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
import {
  clearWatchResume,
  peekWatchResume,
  setWatchResume,
} from "../utils/watchHandoff";

const STAY_DOWNLOAD_TOAST =
  "Downloading - Video will switch to full quality when ready";

const PRESET_LABELS: Record<string, string> = {
  best: "Best available",
  "2160p": "4K",
  "1440p": "1440p",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
  audio: "Audio only",
};

type WatchSource =
  | { kind: "library"; video: Video }
  | { kind: "stream"; url: string; meta: StreamPreviewMeta };

function downloadButtonLabel(preset: string): string {
  if (preset === "best") return "Download Best Quality";
  if (preset === "audio") return "Download Audio Only";
  if (preset === "2160p") return "Download 4K";
  return `Download ${preset}`;
}

function bestAvailablePreset(presets: string[]): string {
  return resolveQualityPreset("best", presets);
}

function orderPresets(presets: string[]): string[] {
  const set = new Set(presets);
  return PRESET_ORDER.filter((p) => p !== "best" && set.has(p));
}

export default function Watch() {
  const { can } = useAuth();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const libraryId = id ? Number(id) : NaN;
  const streamUrlParam = (searchParams.get("url") || "").trim();
  const channelParam = (searchParams.get("channel") || "").trim();

  const [source, setSource] = useState<WatchSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editFocus, setEditFocus] = useState<"notes" | undefined>(undefined);
  const relatedSentinelRef = useRef<HTMLDivElement>(null);
  const [redownloadOpen, setRedownloadOpen] = useState(false);
  const redownloadDialogRef = useRef<HTMLDivElement>(null);
  const presetTriggerRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(redownloadDialogRef, {
    active: redownloadOpen,
    onEscape: () => setRedownloadOpen(false),
  });
  const [redownloadPreset, setRedownloadPreset] = useState("1080p");
  const presets = usePresets();
  const [settings] = useSettings();
  const [chapterError, setChapterError] = useState<string | null>(null);

  // Stream download controls
  const [queuing, setQueuing] = useState(false);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [selectedPreset, setSelectedPreset] = useState("best");
  const [availablePresets, setAvailablePresets] = useState<string[]>([]);
  const [presetSizes, setPresetSizes] = useState<Record<string, number>>({});
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const downloadMenuRef = useRef<HTMLDivElement>(null);
  const swapPendingRef = useRef(false);
  const userPickedPresetRef = useRef(false);
  const activeJobIdRef = useRef<number | null>(null);
  activeJobIdRef.current = activeJobId;

  const { showToast, showError } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const {
    onJobCompleted,
    refreshJobs,
    submitDownload,
    changeJobQuality,
    progress,
    jobs,
  } = useDownloads();
  const redownloadPending = useRef(false);
  const isMobile = useIsMobile();
  const { mode, queue } = usePlaybackSession();
  const { activeStreamQuality } = usePlaybackLayout();
  const {
    playVideo,
    playStream,
    registerDock,
    getCurrentPosition,
    getStreamPosition,
    suspendPlaybackMedia,
    updateCurrentVideo,
  } = usePlaybackActions();

  const dockRef = useRef<HTMLDivElement>(null);

  // --- Load library video ---
  const libraryValid = Number.isFinite(libraryId) && libraryId !== 0;
  const libraryQuery = useQuery({
    ...videoDetailQuery(libraryId),
    // Negative ids are offline-only device downloads (see offline/manager).
    enabled: libraryValid,
    // Keep this page's copy current while the server is still working on it
    // (subtitles, summary, sprites, chapters).
    refetchInterval: (query) => {
      const v = query.state.data;
      return v &&
        (v.subtitles_pending ||
          v.processing_summary ||
          v.processing_sprites ||
          v.processing_chapters)
        ? 3000
        : false;
    },
  });
  const handedOffRef = useRef<number | null>(null);

  useEffect(() => {
    if (!libraryValid) return;
    handedOffRef.current = null;
    suspendPlaybackMedia({ videoId: libraryId });
    setLoading(true);
    setError(null);
  }, [libraryId, libraryValid, suspendPlaybackMedia]);

  useEffect(() => {
    if (!libraryValid) return;
    if (libraryQuery.isError) {
      setError("Video not found");
      setLoading(false);
      return;
    }
    const v = libraryQuery.data;
    if (!v) return;
    if (handedOffRef.current === libraryId) {
      // A later refresh of the same video: update, do not restart playback.
      setSource({ kind: "library", video: v });
      updateCurrentVideo(v);
      return;
    }
    handedOffRef.current = libraryId;
    const fromHandoff = peekWatchResume(libraryId);
    const navResume = (location.state as { resumeAt?: number } | null)
      ?.resumeAt;
    const resumeAt =
      fromHandoff ??
      (typeof navResume === "number" && navResume > 1 ? navResume : null);
    const merged =
      resumeAt != null && resumeAt > 1
        ? { ...v, last_position_sec: resumeAt }
        : v;
    clearWatchResume(libraryId);
    setSource({ kind: "library", video: merged });
    playVideo(merged);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional handoff once per video; the resume position comes from the navigation state at that moment
  }, [libraryQuery.data, libraryQuery.isError, libraryId, libraryValid]);

  // --- Load stream meta ---
  const streamMode = !libraryValid && !!streamUrlParam;
  const metaQuery = useQuery({
    queryKey: queryKeys.preview.meta(streamUrlParam),
    queryFn: ({ signal }) => api.getPreviewMeta(streamUrlParam, { signal }),
    enabled: streamMode,
  });

  useEffect(() => {
    if (libraryValid) return;
    if (!streamUrlParam) {
      setError("Missing video URL");
      setLoading(false);
      return;
    }
    suspendPlaybackMedia({ streamUrl: streamUrlParam });
    setLoading(true);
    setError(null);
    setSource(null);
    setSelectedPreset("best");
    setAvailablePresets([]);
    setPresetSizes({});
    setPresetMenuOpen(false);
    userPickedPresetRef.current = false;
  }, [streamUrlParam, libraryValid, suspendPlaybackMedia]);

  useEffect(() => {
    if (!streamMode) return;
    if (metaQuery.isError) {
      const err = metaQuery.error;
      setError(err instanceof Error ? err.message : "Could not load stream");
      setLoading(false);
      return;
    }
    const meta = metaQuery.data;
    if (!meta) return;
    if (meta.library_video_id != null) {
      navigate(`/watch/${meta.library_video_id}`, { replace: true });
      return;
    }
    setSource({ kind: "stream", url: streamUrlParam, meta });
    setLoading(false);
  }, [
    streamMode,
    metaQuery.data,
    metaQuery.isError,
    metaQuery.error,
    streamUrlParam,
    navigate,
  ]);

  // Start stream playback
  useEffect(() => {
    if (source?.kind !== "stream") return;
    playStream({
      url: source.url,
      title: source.meta.title || "Untitled",
      channel: source.meta.channel ?? null,
      poster: source.meta.thumbnail_url ?? null,
      chapters: parseChapters(source.meta.description),
      sourceUrl: source.meta.source_url,
      channelParam: channelParam || source.meta.channel,
      subtitles: source.meta.subtitles ?? [],
    });
  }, [source, channelParam, playStream]);

  // Resolve download presets for stream
  const streamSource = source?.kind === "stream" ? source : null;
  const streamPreview = useQuery({
    queryKey: queryKeys.preview.download(streamSource?.url ?? ""),
    queryFn: ({ signal }) =>
      api.previewDownload(streamSource?.url ?? "", { signal }),
    enabled: !!streamSource,
  });
  const streamMetaPresets = streamSource?.meta.available_presets;
  const streamPreviewData = streamPreview.data;
  useEffect(() => {
    const applyPresets = (presetsList: string[]) => {
      if (presetsList.length === 0) return;
      const ordered = orderPresets(presetsList);
      if (ordered.length === 0) return;
      setAvailablePresets(ordered);
      if (!userPickedPresetRef.current) {
        setSelectedPreset(bestAvailablePreset(ordered));
      }
    };
    if (streamMetaPresets?.length) applyPresets(streamMetaPresets);
    const p = streamPreviewData;
    if (!p || p.is_playlist) return;
    if (p.available_presets?.length) applyPresets(p.available_presets);
    if (p.preset_sizes && Object.keys(p.preset_sizes).length > 0) {
      setPresetSizes(p.preset_sizes);
    }
  }, [streamMetaPresets, streamPreviewData]);

  useEffect(() => {
    if (!presetMenuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (
        downloadMenuRef.current &&
        !downloadMenuRef.current.contains(e.target as Node)
      ) {
        setPresetMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresetMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [presetMenuOpen]);

  // Resume in-flight download for this stream URL
  useEffect(() => {
    if (source?.kind !== "stream" || activeJobId != null) return;
    const existing = jobs.find(
      (j) => j.url === source.url && isActiveJob(j, progress[j.id])
    );
    if (existing) setActiveJobId(existing.id);
  }, [source, jobs, progress, activeJobId]);

  // Download complete → handoff to library watch
  useEffect(() => {
    return onJobCompleted((completedId) => {
      if (source?.kind !== "stream") return;
      const jobId = activeJobIdRef.current;
      if (jobId == null || completedId == null) return;
      if (swapPendingRef.current) return;

      void (async () => {
        try {
          const job = await api.getJob(jobId);
          if (job.status !== "completed" || job.video_id !== completedId) {
            return;
          }
          swapPendingRef.current = true;
          setActiveJobId(null);

          const sec = getStreamPosition();
          if (sec >= 5) {
            await api.saveProgress(completedId, sec).catch(() => undefined);
          }
          const video = await queryClient.fetchQuery({
            ...videoDetailQuery(completedId),
            staleTime: 0,
          });
          const resumeAt = sec > 1 ? sec : video.last_position_sec;
          setWatchResume(completedId, resumeAt);
          const handedOff = {
            ...video,
            last_position_sec: resumeAt,
          };
          setSource({ kind: "library", video: handedOff });
          playVideo(handedOff);
          showToast("Download complete — switching to full quality");
          navigate(`/watch/${completedId}`, {
            state: { resumeAt },
          });
        } catch {
          showError("Download finished, but could not open the video");
          swapPendingRef.current = false;
        }
      })();
    });
  }, [
    onJobCompleted,
    source,
    getStreamPosition,
    playVideo,
    navigate,
    showToast,
    showError,
    queryClient,
  ]);

  useEffect(() => {
    if (activeJobId == null) return;
    const live = progress[activeJobId];
    if (!live) return;
    if (live.status === "error") {
      showError(live.error || "Download failed");
      setActiveJobId(null);
      swapPendingRef.current = false;
    } else if (live.status === "cancelled") {
      setActiveJobId(null);
      swapPendingRef.current = false;
    }
  }, [activeJobId, progress, showToast, showError]);

  // --- Library-only: which AI features this install offers ---
  const isLibrarySource = source?.kind === "library";
  const appSettings = useQuery({
    queryKey: queryKeys.app.settings,
    queryFn: ({ signal }) => api.getAppSettings({ signal }),
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

  useEffect(() => {
    return onJobCompleted((completedId, event) => {
      if (!redownloadPending.current || !video || completedId !== video.id)
        return;
      redownloadPending.current = false;

      void (async () => {
        try {
          const sec = getCurrentPosition();
          if (sec >= 5) {
            await api.saveProgress(video.id, sec).catch(() => undefined);
          }
          const updated = await queryClient.fetchQuery({
            ...videoDetailQuery(video.id),
            staleTime: 0,
          });
          const resumeAt = sec > 1 ? sec : updated.last_position_sec;
          const merged = { ...updated, last_position_sec: resumeAt };
          setSource({ kind: "library", video: merged });
          playVideo(merged);
          if (event?.quality_warning) {
            showToast(event.quality_warning);
          } else {
            showToast("Redownload complete — switching to new quality");
          }
        } catch {
          queryClient
            .fetchQuery({ ...videoDetailQuery(video.id), staleTime: 0 })
            .then((v) => setSource({ kind: "library", video: v }))
            .catch(() => undefined);
          showToast(event?.quality_warning || "Redownload complete.");
        }
      })();
    });
  }, [
    onJobCompleted,
    video,
    showToast,
    getCurrentPosition,
    playVideo,
    queryClient,
  ]);

  const setVideo = useCallback(
    (v: Video) => {
      setSource({ kind: "library", video: v });
      updateCurrentVideo(v);
      // The library lists and this page's copy show the edit too.
      queryClient.setQueryData(queryKeys.videos.detail(v.id), v);
      replaceVideoInLists(queryClient, v);
    },
    [updateCurrentVideo, queryClient]
  );

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

  const redownloadMutation = useMutation({
    mutationFn: (v: {
      id: number;
      preset: string;
      normalize: boolean;
      message: string;
      closeDialog: boolean;
    }) =>
      api.redownloadVideo(
        v.id,
        v.preset,
        v.normalize,
        settings.downloadVideoCodec
      ),
    onMutate: () => {
      redownloadPending.current = true;
    },
    onSuccess: (_video, v) => {
      showToast(v.message);
      refreshJobs();
      if (v.closeDialog) setRedownloadOpen(false);
    },
    onError: (err) => {
      redownloadPending.current = false;
      showError(describeError(err) || "Could not start download");
    },
  });
  const redownloading = redownloadMutation.isPending;

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteVideo(id, true),
    onSuccess: () => {
      for (const queryKey of [
        queryKeys.videos.all,
        queryKeys.channels.all,
        queryKeys.tags.all,
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
      navigate("/");
    },
    onError: (err) => showError(describeError(err) || "Could not delete video"),
  });

  const onRedownload = () => {
    if (!video) return;
    redownloadMutation.mutate({
      id: video.id,
      preset: redownloadPreset,
      normalize: settings.normalizeVolumeOnDownload,
      message: "Download started — check the Download page for progress.",
      closeDialog: true,
    });
  };

  const onNormalizeVolume = () => {
    if (!video) return;
    const h = video.height_px;
    let preset = "best";
    if (h && h > 0) {
      if (h >= 2160) preset = "2160p";
      else if (h >= 1440) preset = "1440p";
      else if (h >= 1080) preset = "1080p";
      else if (h >= 720) preset = "720p";
      else if (h >= 480) preset = "480p";
    }
    if (!presets.includes(preset)) {
      preset = presets.includes("1080p") ? "1080p" : (presets[0] ?? "best");
    }
    redownloadMutation.mutate({
      id: video.id,
      preset,
      normalize: true,
      message:
        "Normalizing via redownload — check the Download page for progress.",
      closeDialog: false,
    });
  };

  const onDelete = async () => {
    if (!video) return;
    const ok = await confirm({
      title: "Delete this video?",
      body: `"${video.title}" will be removed from your library and the file will be permanently deleted.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    deleteMutation.mutate(video.id);
  };

  async function handleStreamDownload() {
    if (source?.kind !== "stream" || queuing) return;
    setPresetMenuOpen(false);
    setQueuing(true);
    try {
      const job = await submitDownload(source.url, selectedPreset, {
        title: source.meta.title ?? undefined,
        channel: source.meta.channel ?? (channelParam || undefined),
      });
      setActiveJobId(job.id);
      swapPendingRef.current = false;
      showToast(STAY_DOWNLOAD_TOAST);
    } catch (err: unknown) {
      showToast(
        err instanceof Error ? err.message : "Could not start download"
      );
    } finally {
      setQueuing(false);
    }
  }

  async function handleChangeDownloadQuality(preset: string) {
    if (activeJobId == null || preset === selectedPreset) return;
    userPickedPresetRef.current = true;
    setSelectedPreset(preset);
    try {
      await changeJobQuality(activeJobId, preset);
    } catch (err: unknown) {
      if (activeJob?.quality_preset) {
        setSelectedPreset(
          resolveQualityPreset(
            activeJob.quality_preset,
            activeJob.available_presets ?? availablePresets
          )
        );
      }
      showToast(
        err instanceof Error ? err.message : "Could not change resolution"
      );
    }
  }

  const presetOptions = useMemo(() => {
    if (availablePresets.length > 0) return availablePresets;
    const job =
      activeJobId != null ? jobs.find((j) => j.id === activeJobId) : undefined;
    const fromJob = job?.available_presets ?? [];
    if (fromJob.length > 0) return orderPresets(fromJob);
    return ["best"];
  }, [availablePresets, activeJobId, jobs]);

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

  const live = activeJobId != null ? progress[activeJobId] : undefined;
  const activeJob =
    activeJobId != null
      ? (jobs.find((j) => j.id === activeJobId) ?? null)
      : null;
  const downloadPercent = downloadProgressPercent(
    live?.progress ?? activeJob?.progress,
    live?.downloaded_bytes,
    live?.total_bytes
  );
  const downloadActive = activeJob != null && isActiveJob(activeJob, live);

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
                  {!isLibrary && !downloadActive && can("download") && (
                    <div className="relative" ref={downloadMenuRef}>
                      <div className="inline-flex overflow-hidden rounded-lg bg-accent text-xs font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-60">
                        <button
                          type="button"
                          onClick={() => void handleStreamDownload()}
                          disabled={queuing}
                          className="px-3 py-1 disabled:opacity-60"
                        >
                          {queuing
                            ? "Queuing…"
                            : downloadButtonLabel(selectedPreset)}
                        </button>
                        <button
                          ref={presetTriggerRef}
                          type="button"
                          onClick={() => setPresetMenuOpen((v) => !v)}
                          disabled={queuing}
                          aria-label="Choose download quality"
                          aria-expanded={presetMenuOpen}
                          aria-haspopup="menu"
                          className="border-l border-ink-950/25 px-2 py-1 disabled:opacity-60"
                        >
                          <span
                            className={`inline-block text-[10px] leading-none transition-transform ${
                              presetMenuOpen ? "rotate-180" : ""
                            }`}
                          >
                            ▼
                          </span>
                        </button>
                      </div>
                      <MenuFlyout
                        open={presetMenuOpen}
                        className="absolute left-0 z-30 mt-1 min-w-[12rem]"
                        menu={{
                          label: "Download quality",
                          onClose: () => setPresetMenuOpen(false),
                          triggerRef: presetTriggerRef,
                        }}
                      >
                        <MenuScroll
                          className="max-h-60"
                          revision={presetOptions.length}
                        >
                          <ul role="none">
                            {presetOptions.map((p) => (
                              <li key={p} role="none">
                                <button
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={p === selectedPreset}
                                  onClick={() => {
                                    userPickedPresetRef.current = true;
                                    setSelectedPreset(p);
                                    setPresetMenuOpen(false);
                                  }}
                                  className={`flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-xs hover:bg-ink-800 ${
                                    p === selectedPreset
                                      ? "font-semibold text-accent"
                                      : "text-gray-200"
                                  }`}
                                >
                                  <span>
                                    {presetOptionLabel(p, presetSizes)}
                                  </span>
                                  {p === selectedPreset && (
                                    <span className="text-accent">✓</span>
                                  )}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </MenuScroll>
                      </MenuFlyout>
                    </div>
                  )}
                  {!isLibrary && downloadActive && (
                    <span className="inline-flex items-center gap-2 text-xs font-medium text-gray-300">
                      <span>
                        {live?.status === "processing"
                          ? downloadProcessingLabel(live?.stage)
                          : live?.status === "queued"
                            ? "Queued…"
                            : `Downloading ${downloadPercent}%`}
                      </span>
                      <span className="inline-block h-1 w-20 overflow-hidden rounded-full bg-ink-800">
                        <span
                          className="block h-full rounded-full bg-accent/70 transition-all duration-300"
                          style={{ width: `${downloadPercent}%` }}
                        />
                      </span>
                      {(live?.downloaded_bytes != null ||
                        live?.total_bytes != null) && (
                        <span className="text-[10px] text-muted">
                          {live.downloaded_bytes != null
                            ? formatSize(live.downloaded_bytes)
                            : "…"}
                          {live.total_bytes != null
                            ? ` / ${formatSize(live.total_bytes)}`
                            : ""}
                        </span>
                      )}
                      {presetOptions.length > 0 && (
                        <ThemedSelect
                          aria-label="Download resolution"
                          size="compact"
                          value={resolveQualityPreset(
                            activeJob?.quality_preset || selectedPreset,
                            activeJob?.available_presets ?? availablePresets
                          )}
                          options={presetOptions.map((p) => ({
                            value: p,
                            label: presetOptionLabel(p, presetSizes),
                          }))}
                          onChange={(preset) =>
                            void handleChangeDownloadQuality(preset)
                          }
                          buttonClassName="cursor-pointer bg-ink-800 text-[11px] font-medium text-gray-300"
                        />
                      )}
                    </span>
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

            {isLibrary && editing && (
              <div className="mt-4">
                <VideoEditForm
                  video={source.video}
                  saveLabel="Save changes"
                  focusField={editFocus}
                  onCancel={() => {
                    setEditing(false);
                    setEditFocus(undefined);
                  }}
                  onSaved={(updated) => {
                    setVideo(updated);
                    setEditing(false);
                    setEditFocus(undefined);
                  }}
                />
              </div>
            )}

            {isLibrary && (
              <div className="mt-5 flex flex-wrap gap-2 whitespace-nowrap">
                <Link
                  to="/"
                  aria-label={isMobile ? "Back to library" : undefined}
                  className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700"
                >
                  {/* Phones: icon only, so the Download button fits the row. */}
                  {isMobile ? "←" : "← Back to library"}
                </Link>
                {source.video.id > 0 && can("manage_playlists") && (
                  <AddToPlaylist videoId={source.video.id} />
                )}
                {/* Phones get a dedicated button; desktop uses the ••• menu. */}
                {isMobile && can("offline_download") && (
                  <OfflineDownloadButton video={source.video} />
                )}
                {source.video.id > 0 && (
                  <VideoActionsMenu
                    video={source.video}
                    onEdit={() => {
                      setEditFocus(undefined);
                      setEditing((v) => !v);
                    }}
                    onAddNote={() => {
                      setEditFocus("notes");
                      setEditing(true);
                    }}
                    onChangeResolution={() => setRedownloadOpen(true)}
                    onNormalizeVolume={onNormalizeVolume}
                    onDelete={onDelete}
                    onVideoUpdated={setVideo}
                  />
                )}
              </div>
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

      {isLibrary && redownloadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div
            ref={redownloadDialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="redownload-title"
            className="w-full max-w-md rounded-xl bg-ink-900 p-6 outline-none ring-1 ring-ink-700"
          >
            <h2
              id="redownload-title"
              className="mb-1 text-lg font-semibold text-gray-100"
            >
              Change resolution
            </h2>
            <p className="mb-4 text-sm text-gray-400">
              This replaces the video file on disk with a newly downloaded copy
              at the selected resolution. Your title, notes, and other metadata
              are kept. Playback may be unavailable until the download finishes.
            </p>
            {source.kind === "library" && source.video.height_px != null && (
              <p className="mb-3 text-xs text-muted">
                Current file:{" "}
                <span className="text-gray-300">
                  {formatResolution(source.video.height_px) ||
                    `${source.video.height_px}p`}
                </span>
                {source.video.width_px != null
                  ? ` (${source.video.width_px}×${source.video.height_px})`
                  : ""}
              </p>
            )}
            <span className="mb-1 block text-xs font-medium text-gray-400">
              Quality
            </span>
            <ThemedSelect
              aria-label="Quality"
              value={redownloadPreset}
              options={presets.map((p) => ({
                value: p,
                label: PRESET_LABELS[p] ?? p,
              }))}
              onChange={setRedownloadPreset}
              className="mb-2 w-full"
              buttonClassName="w-full px-3 py-2.5"
            />
            <p className="mb-6 text-xs text-muted">
              YouTube (and other sites) may not offer the selected tier. If the
              downloaded file is lower, Horde shows a toast when the job
              finishes.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRedownloadOpen(false)}
                className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
              >
                Cancel
              </button>
              <button
                onClick={onRedownload}
                disabled={redownloading}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:opacity-50"
              >
                {redownloading ? "Starting…" : "Replace file"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
