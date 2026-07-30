import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, thumbnailUrl } from "../api";
import AddToPlaylist from "../components/AddToPlaylist";
import LoadingIndicator from "../components/LoadingIndicator";
import PlaybackQueue from "../components/PlaybackQueue";
import VideoActionsMenu from "../components/VideoActionsMenu";
import VideoAiPanel from "../components/VideoAiPanel";
import VideoCard from "../components/VideoCard";
import VideoEditForm from "../components/VideoEditForm";
import WatchMeta from "../components/WatchMeta";
import {
  isActiveJob,
  useDownloads,
} from "../context/DownloadContext";
import { usePlayback } from "../context/PlaybackContext";
import { useToast } from "../context/ToastContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSettings } from "../hooks/useSettings";
import { PRESET_ORDER, presetOptionLabel } from "../presets";
import type { StreamPreviewMeta, Video } from "../types";
import {
  formatDate,
  formatDuration,
  formatResolution,
  formatSize,
  formatViewCount,
  parseChapters,
  stripChapterLines,
} from "../utils";
import {
  clearWatchResume,
  peekWatchResume,
  setWatchResume,
} from "../utils/watchHandoff";

const RELATED_PAGE = 8;
const RELATED_MAX = 48;

const STAY_DOWNLOAD_TOAST =
  "Downloading - Video will switch to full quality when ready";

const PRESET_LABELS: Record<string, string> = {
  best: "Best available",
  "2160p": "4K (2160p)",
  "1440p": "1440p (2K)",
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
  for (const p of PRESET_ORDER) {
    if (p === "best" || p === "audio") continue;
    if (presets.includes(p)) return p;
  }
  if (presets.includes("audio")) return "audio";
  return "best";
}

function orderPresets(presets: string[]): string[] {
  const set = new Set(presets);
  return PRESET_ORDER.filter((p) => p !== "best" && set.has(p));
}

export default function Watch() {
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
  const [moreLikeThis, setMoreLikeThis] = useState<Video[]>([]);
  const [relatedHasMore, setRelatedHasMore] = useState(false);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const relatedSentinelRef = useRef<HTMLDivElement>(null);
  const [redownloadOpen, setRedownloadOpen] = useState(false);
  const [redownloadPreset, setRedownloadPreset] = useState("1080p");
  const [presets, setPresets] = useState<string[]>(["best"]);
  const [redownloading, setRedownloading] = useState(false);
  const [settings] = useSettings();
  const [aiSummariesEnabled, setAiSummariesEnabled] = useState(false);
  const [aiChatEnabled, setAiChatEnabled] = useState(false);
  const [showAiCosts, setShowAiCosts] = useState(false);

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

  const { showToast } = useToast();
  const { onJobCompleted, refreshJobs, submitDownload, progress, jobs } =
    useDownloads();
  const redownloadPending = useRef(false);
  const isMobile = useIsMobile();
  const {
    mode,
    playVideo,
    playStream,
    registerDock,
    queue,
    getCurrentPosition,
    getStreamPosition,
  } = usePlayback();

  const dockRef = useRef<HTMLDivElement>(null);

  // --- Load library video ---
  useEffect(() => {
    if (!Number.isFinite(libraryId) || libraryId <= 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fromHandoff = peekWatchResume(libraryId);
    const navResume = (location.state as { resumeAt?: number } | null)?.resumeAt;
    const resumeAt =
      fromHandoff ??
      (typeof navResume === "number" && navResume > 1 ? navResume : null);

    api
      .getVideo(libraryId)
      .then((v) => {
        if (cancelled) return;
        const merged =
          resumeAt != null && resumeAt > 1
            ? { ...v, last_position_sec: resumeAt }
            : v;
        clearWatchResume(libraryId);
        setSource({ kind: "library", video: merged });
        playVideo(merged);
      })
      .catch(() => {
        if (!cancelled) setError("Video not found");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional handoff once
  }, [libraryId, playVideo]);

  // --- Load stream meta ---
  useEffect(() => {
    if (Number.isFinite(libraryId) && libraryId > 0) return;
    if (!streamUrlParam) {
      setError("Missing video URL");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSource(null);
    setSelectedPreset("best");
    setAvailablePresets([]);
    setPresetSizes({});
    setPresetMenuOpen(false);
    userPickedPresetRef.current = false;
    api
      .getPreviewMeta(streamUrlParam)
      .then((meta) => {
        if (cancelled) return;
        if (meta.library_video_id != null) {
          navigate(`/watch/${meta.library_video_id}`, { replace: true });
          return;
        }
        setSource({ kind: "stream", url: streamUrlParam, meta });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Could not load stream"
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [streamUrlParam, libraryId, navigate]);

  // Start stream playback
  useEffect(() => {
    if (source?.kind !== "stream") return;
    playStream({
      url: source.url,
      title: source.meta.title || "Untitled",
      channel: source.meta.channel,
      poster: source.meta.thumbnail_url,
      chapters: parseChapters(source.meta.description),
      sourceUrl: source.meta.source_url,
      channelParam: channelParam || source.meta.channel,
      subtitles: source.meta.subtitles ?? [],
    });
  }, [source, channelParam, playStream]);

  // Resolve download presets for stream
  useEffect(() => {
    if (source?.kind !== "stream") return;
    const { url, meta } = source;
    let cancelled = false;
    const applyPresets = (presetsList: string[]) => {
      if (cancelled || presetsList.length === 0) return;
      const ordered = orderPresets(presetsList);
      if (ordered.length === 0) return;
      setAvailablePresets(ordered);
      if (!userPickedPresetRef.current) {
        setSelectedPreset(bestAvailablePreset(ordered));
      }
    };
    if (meta.available_presets?.length) applyPresets(meta.available_presets);
    api
      .previewDownload(url)
      .then((p) => {
        if (cancelled || p.is_playlist) return;
        if (p.available_presets?.length) applyPresets(p.available_presets);
        if (p.preset_sizes && Object.keys(p.preset_sizes).length > 0) {
          setPresetSizes(p.preset_sizes);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [source]);

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
          const video = await api.getVideo(completedId);
          const resumeAt = sec > 1 ? sec : video.last_position_sec;
          setWatchResume(completedId, resumeAt);
          playVideo({
            ...video,
            last_position_sec: resumeAt,
          });
          showToast("Download complete — switching to full quality");
          navigate(`/watch/${completedId}`, {
            state: { resumeAt },
          });
        } catch {
          showToast("Download finished, but could not open the video");
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
  ]);

  useEffect(() => {
    if (activeJobId == null) return;
    const live = progress[activeJobId];
    if (!live) return;
    if (live.status === "error") {
      showToast(live.error || "Download failed");
      setActiveJobId(null);
      swapPendingRef.current = false;
    } else if (live.status === "cancelled") {
      setActiveJobId(null);
      swapPendingRef.current = false;
    }
  }, [activeJobId, progress, showToast]);

  // --- Library-only effects ---
  useEffect(() => {
    if (source?.kind !== "library") return;
    let cancelled = false;
    Promise.all([api.getAppSettings(), api.getAiStatus()])
      .then(([s, status]) => {
        if (cancelled) return;
        const openRouterConnected =
          !!status.openrouter_enabled && !!status.openrouter_api_key_set;
        const localConnected = !!status.enabled && !!status.reachable;
        const llmConnected = openRouterConnected || localConnected;
        setAiSummariesEnabled(llmConnected && !!s.ai.ai_summaries);
        setAiChatEnabled(llmConnected && !!s.ai.ai_chat);
        setShowAiCosts(
          openRouterConnected && s.ai.openrouter_show_costs !== false
        );
      })
      .catch(() => {
        if (cancelled) return;
        setAiSummariesEnabled(false);
        setAiChatEnabled(false);
        setShowAiCosts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source?.kind]);

  const video = source?.kind === "library" ? source.video : null;

  useEffect(() => {
    if (!video) return;
    setMoreLikeThis([]);
    setRelatedHasMore(false);
    api
      .getRelatedVideos(video.id, RELATED_PAGE, 0)
      .then((rows) => {
        setMoreLikeThis(rows);
        setRelatedHasMore(
          rows.length >= RELATED_PAGE && rows.length < RELATED_MAX
        );
      })
      .catch(() => setMoreLikeThis([]));
  }, [video?.id]);

  const loadMoreRelated = useCallback(async () => {
    if (!video || relatedLoading || !relatedHasMore) return;
    if (moreLikeThis.length >= RELATED_MAX) {
      setRelatedHasMore(false);
      return;
    }
    setRelatedLoading(true);
    try {
      const rows = await api.getRelatedVideos(
        video.id,
        RELATED_PAGE,
        moreLikeThis.length
      );
      setMoreLikeThis((prev) => {
        const seen = new Set(prev.map((v) => v.id));
        const next = [...prev, ...rows.filter((v) => !seen.has(v.id))];
        return next.slice(0, RELATED_MAX);
      });
      setRelatedHasMore(
        rows.length >= RELATED_PAGE &&
          moreLikeThis.length + rows.length < RELATED_MAX
      );
    } catch {
      setRelatedHasMore(false);
    } finally {
      setRelatedLoading(false);
    }
  }, [video, relatedLoading, relatedHasMore, moreLikeThis.length]);

  useEffect(() => {
    if (!relatedHasMore) return;
    const el = relatedSentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMoreRelated();
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [relatedHasMore, loadMoreRelated]);

  useEffect(() => {
    if (!video?.subtitles_pending) return;
    const timer = window.setInterval(() => {
      api.getVideo(video.id).then((v) => {
        setSource({ kind: "library", video: v });
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [video?.id, video?.subtitles_pending]);

  useEffect(() => {
    if (!source) return;
    registerDock(dockRef.current);
    return () => registerDock(null);
  }, [registerDock, source, mode]);

  useEffect(() => {
    api.listPresets().then(setPresets).catch(() => undefined);
  }, []);

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
          const updated = await api.getVideo(video.id);
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
          api
            .getVideo(video.id)
            .then((v) => setSource({ kind: "library", video: v }))
            .catch(() => undefined);
          showToast(event?.quality_warning || "Redownload complete.");
        }
      })();
    });
  }, [onJobCompleted, video, showToast, getCurrentPosition, playVideo]);

  const setVideo = useCallback((v: Video) => {
    setSource({ kind: "library", video: v });
  }, []);

  const onRedownload = async () => {
    if (!video) return;
    setRedownloading(true);
    try {
      redownloadPending.current = true;
      await api.redownloadVideo(
        video.id,
        redownloadPreset,
        settings.normalizeVolumeOnDownload
      );
      showToast("Download started — check the Download page for progress.");
      refreshJobs();
      setRedownloadOpen(false);
    } catch (err) {
      redownloadPending.current = false;
      showToast(
        err instanceof Error ? err.message : "Could not start download"
      );
    } finally {
      setRedownloading(false);
    }
  };

  const onNormalizeVolume = async () => {
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
      preset = presets.includes("1080p") ? "1080p" : presets[0] ?? "best";
    }
    setRedownloading(true);
    try {
      redownloadPending.current = true;
      await api.redownloadVideo(video.id, preset, true);
      showToast(
        "Normalizing via redownload — check the Download page for progress."
      );
      refreshJobs();
    } catch (err) {
      redownloadPending.current = false;
      showToast(
        err instanceof Error ? err.message : "Could not start download"
      );
    } finally {
      setRedownloading(false);
    }
  };

  const onDelete = async () => {
    if (!video) return;
    if (!confirm(`Delete "${video.title}" from the library?`)) return;
    try {
      await api.deleteVideo(video.id, true);
      navigate("/");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Could not delete video"
      );
    }
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

  const presetOptions = useMemo(() => {
    if (availablePresets.length > 0) return availablePresets;
    return ["best"];
  }, [availablePresets]);

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
  const chapters = parseChapters(description);
  const descriptionBody = stripChapterLines(description);
  const queueVisible = isLibrary && queue.length > 0;

  const live = activeJobId != null ? progress[activeJobId] : undefined;
  const activeJob =
    activeJobId != null
      ? jobs.find((j) => j.id === activeJobId) ?? null
      : null;
  const downloadPercent = Math.round(
    Math.min(100, Math.max(0, live?.progress ?? activeJob?.progress ?? 0))
  );
  const downloadActive =
    activeJob != null && isActiveJob(activeJob, live);

  const streamRes =
    source.kind === "stream"
      ? formatResolution(source.meta.preview_height)
      : "";
  const resolution = isLibrary
    ? formatResolution(source.video.height_px)
    : streamRes;

  const contentClass = showRelatedRight
    ? "mx-auto max-w-[90rem]"
    : "mx-auto max-w-5xl xl:max-w-6xl 2xl:max-w-7xl";

  const playerOuterClass = isMobile
    ? "relative left-1/2 w-screen -translate-x-1/2 bg-black"
    : isWide
      ? "relative left-1/2 w-screen -translate-x-1/2 bg-black"
      : showRelatedRight
        ? "w-full bg-black"
        : "mx-auto max-w-5xl";
  const playerInnerClass = isWide && !isMobile ? "mx-auto w-full" : "w-full";

  const channelHref = channelName
    ? `/?channel=${encodeURIComponent(channelName)}`
    : "/";
  const backHref = channelParam
    ? `/?channel=${encodeURIComponent(channelParam)}`
    : "/";

  const canAiSummarize =
    isLibrary &&
    aiSummariesEnabled &&
    (source.video.subtitles?.length ?? 0) > 0;
  const canAiChat =
    isLibrary &&
    aiChatEnabled &&
    !!(
      (source.video.title || "").trim() ||
      (source.video.description || "").trim() ||
      (source.video.subtitles?.length ?? 0) > 0
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
                    src={thumb}
                    alt={v.title}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-ink-600">
                    <span className="text-xl">▶</span>
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 py-0.5">
                <p className="line-clamp-2 text-sm font-medium text-gray-200 group-hover:text-accent">
                  {v.title}
                </p>
                {v.channel && (
                  <p className="mt-0.5 truncate text-xs text-gray-500">
                    {v.channel}
                  </p>
                )}
                {v.duration_sec != null && (
                  <p className="mt-0.5 text-xs text-gray-600">
                    {formatDuration(v.duration_sec)}
                  </p>
                )}
              </div>
            </Link>
          );
        })}
      </div>
      <div ref={relatedSentinelRef} className="h-2" />
      {relatedLoading && (
        <p className="text-xs text-gray-500">Loading more…</p>
      )}
    </div>
  ) : null;

  return (
    <div className={`${contentClass} ${isWide ? "-mt-6" : ""}`}>
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

          <div className={isWide ? "px-3 md:px-6" : undefined}>
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
                          })
                          .catch(() => null);
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
                          })
                          .catch(() => null);
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
                    <span className="text-xs text-gray-500">{resolution}</span>
                  )}
                  {isLibrary &&
                    source.video.frame_rate &&
                    source.video.frame_rate > 60 && (
                      <span className="text-xs text-gray-500">
                        {Math.round(source.video.frame_rate)}fps
                      </span>
                    )}
                  {!isLibrary && !downloadActive && (
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
                          type="button"
                          onClick={() => setPresetMenuOpen((v) => !v)}
                          disabled={queuing}
                          aria-label="Choose download quality"
                          aria-expanded={presetMenuOpen}
                          aria-haspopup="listbox"
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
                      {presetMenuOpen && (
                        <ul
                          role="listbox"
                          aria-label="Download quality"
                          className="absolute left-0 z-30 mt-1 min-w-[12rem] overflow-hidden rounded-lg border border-ink-700 bg-ink-900 py-1 shadow-lg ring-1 ring-ink-700"
                        >
                          {presetOptions.map((p) => (
                            <li
                              key={p}
                              role="option"
                              aria-selected={p === selectedPreset}
                            >
                              <button
                                type="button"
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
                      )}
                    </div>
                  )}
                  {!isLibrary && downloadActive && (
                    <span className="inline-flex items-center gap-2 text-xs font-medium text-gray-300">
                      <span>
                        {live?.status === "processing"
                          ? "Processing…"
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
                        <span className="text-[10px] text-gray-600">
                          {live.downloaded_bytes != null
                            ? formatSize(live.downloaded_bytes)
                            : "…"}
                          {live.total_bytes != null
                            ? ` / ${formatSize(live.total_bytes)}`
                            : ""}
                        </span>
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
                {isLibrary && showAiSection && (
                  <VideoAiPanel
                    video={source.video}
                    canSummarize={canAiSummarize}
                    canChat={canAiChat}
                    showCosts={showAiCosts}
                    onVideoUpdate={setVideo}
                    showToast={showToast}
                  />
                )}

                <WatchMeta
                  description={descriptionBody}
                  chapters={chapters}
                  queueVisible={queueVisible}
                  notes={isLibrary ? source.video.notes : null}
                  tags={isLibrary ? source.video.tags : []}
                  aiTags={isLibrary ? source.video.ai_tags : []}
                  userTags={isLibrary ? source.video.user_tags : []}
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
              <div className="mt-5 flex gap-2">
                <Link
                  to="/"
                  className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700"
                >
                  ← Back to library
                </Link>
                <AddToPlaylist videoId={source.video.id} />
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
              </div>
            )}

            {isLibrary &&
              !showRelatedRight &&
              moreLikeThis.length > 0 && (
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
            {queue.length > 0 && (
              <PlaybackQueue className="sticky top-20" />
            )}
            <div className={queue.length > 0 ? "" : "sticky top-20"}>
              {relatedList}
            </div>
          </aside>
        )}
      </div>

      {isLibrary && redownloadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700">
            <h2 className="mb-1 text-lg font-semibold text-gray-100">
              Change resolution
            </h2>
            <p className="mb-4 text-sm text-gray-400">
              This replaces the video file on disk with a newly downloaded copy
              at the selected resolution. Your title, notes, and other metadata
              are kept. Playback may be unavailable until the download finishes.
            </p>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Quality
            </label>
            <select
              value={redownloadPreset}
              onChange={(e) => setRedownloadPreset(e.target.value)}
              className="mb-6 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-gray-100 outline-none focus:border-accent"
            >
              {presets.map((p) => (
                <option key={p} value={p}>
                  {PRESET_LABELS[p] ?? p}
                </option>
              ))}
            </select>
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
