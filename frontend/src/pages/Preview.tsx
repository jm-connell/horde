import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import ChaptersList from "../components/ChaptersList";
import Collapse from "../components/Collapse";
import HelpTip from "../components/HelpTip";
import LinkifiedText from "../components/LinkifiedText";
import LoadingIndicator from "../components/LoadingIndicator";
import {
  isActiveJob,
  useDownloads,
} from "../context/DownloadContext";
import { usePlayback } from "../context/PlaybackContext";
import { useToast } from "../context/ToastContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSettings } from "../hooks/useSettings";
import { PRESET_ORDER, presetOptionLabel } from "../presets";
import type { StreamPreviewMeta } from "../types";
import {
  formatDuration,
  formatResolution,
  formatSize,
  formatViewCount,
  parseChapters,
  stripChapterLines,
} from "../utils";
import { setWatchResume } from "../utils/watchHandoff";

const PREVIEW_QUALITY_TIP =
  "Preview streams are limited to progressive (muxed) formats—often 360p, sometimes up to 720p. YouTube serves higher resolutions as separate adaptive video/audio streams that are unreliable to proxy cleanly in-browser. Download the video for full quality.";

const STAY_DOWNLOAD_TOAST =
  "Downloading - Video will switch to full quality when ready";

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

export default function Preview() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const url = (params.get("url") || "").trim();
  const channelParam = (params.get("channel") || "").trim();
  const [meta, setMeta] = useState<StreamPreviewMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [descExpanded, setDescExpanded] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [selectedPreset, setSelectedPreset] = useState("best");
  const [availablePresets, setAvailablePresets] = useState<string[]>([]);
  const [presetSizes, setPresetSizes] = useState<Record<string, number>>({});
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [settings, updateSettings] = useSettings();
  const { showToast } = useToast();
  const { submitDownload, progress, jobs, onJobCompleted } = useDownloads();
  const {
    mode,
    playPreview,
    playVideo,
    registerDock,
    getPreviewPosition,
  } = usePlayback();
  const isMobile = useIsMobile();
  const dockRef = useRef<HTMLDivElement>(null);
  const downloadMenuRef = useRef<HTMLDivElement>(null);
  const swapPendingRef = useRef(false);
  const userPickedPresetRef = useRef(false);
  const activeJobIdRef = useRef<number | null>(null);
  activeJobIdRef.current = activeJobId;

  useEffect(() => {
    if (!url) {
      setError("Missing video URL");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMeta(null);
    setSelectedPreset("best");
    setAvailablePresets([]);
    setPresetSizes({});
    setPresetMenuOpen(false);
    userPickedPresetRef.current = false;
    api
      .getPreviewMeta(url)
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const detail =
          err instanceof Error ? err.message : "Could not load preview";
        setError(detail);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Secondary: resolve available download resolutions after preview is up.
  useEffect(() => {
    if (!meta || !url || meta.library_video_id != null) return;
    let cancelled = false;

    const applyPresets = (presets: string[]) => {
      if (cancelled || presets.length === 0) return;
      const ordered = orderPresets(presets);
      if (ordered.length === 0) return;
      setAvailablePresets(ordered);
      if (!userPickedPresetRef.current) {
        setSelectedPreset(bestAvailablePreset(ordered));
      }
    };

    // Prefer presets already on stream meta; refresh via download preview when empty.
    if (meta.available_presets?.length) {
      applyPresets(meta.available_presets);
    }

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
  }, [meta, url]);

  // Close resolution menu on outside click / Escape.
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

  const chapters = useMemo(
    () => parseChapters(meta?.description ?? null),
    [meta?.description]
  );

  // Start preview playback in the shared player once meta is ready.
  useEffect(() => {
    if (!meta || !url) return;
    playPreview({
      url,
      title: meta.title || "Preview",
      channel: meta.channel,
      poster: meta.thumbnail_url,
      chapters: parseChapters(meta.description),
      sourceUrl: meta.source_url,
      channelParam: channelParam || meta.channel,
    });
  }, [meta, url, channelParam, playPreview]);

  // Dock the persistent player while on this page (same pattern as Watch).
  useEffect(() => {
    if (!meta) return;
    registerDock(dockRef.current);
    return () => registerDock(null);
  }, [registerDock, meta, mode]);

  // Resume tracking an in-flight download for this URL (e.g. after remount).
  useEffect(() => {
    if (!url || activeJobId != null) return;
    const existing = jobs.find(
      (j) => j.url === url && isActiveJob(j, progress[j.id])
    );
    if (existing) setActiveJobId(existing.id);
  }, [url, jobs, progress, activeJobId]);

  // When download finishes, hand off to library watch at the same timestamp.
  useEffect(() => {
    return onJobCompleted((completedId) => {
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

          const sec = getPreviewPosition();
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
    getPreviewPosition,
    playVideo,
    navigate,
    showToast,
  ]);

  // Surface download errors for the active job.
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

  const descriptionBody = stripChapterLines(meta?.description ?? null);
  const showDescriptionPanel =
    settings.showDescription && !!descriptionBody;
  const metaSideBySide = chapters.length > 0 && showDescriptionPanel;
  const isWide = mode === "theater";
  const backHref = channelParam
    ? `/?channel=${encodeURIComponent(channelParam)}&tab=feed`
    : "/";

  const playerOuterClass = isMobile
    ? "relative left-1/2 w-screen -translate-x-1/2 bg-black"
    : isWide
      ? "relative left-1/2 w-screen -translate-x-1/2 bg-black"
      : "mx-auto max-w-5xl";

  const live =
    activeJobId != null ? progress[activeJobId] : undefined;
  const activeJob =
    activeJobId != null
      ? jobs.find((j) => j.id === activeJobId) ?? null
      : null;
  const downloadPercent = Math.round(
    Math.min(100, Math.max(0, live?.progress ?? activeJob?.progress ?? 0))
  );
  const downloadActive =
    activeJob != null && isActiveJob(activeJob, live);

  async function handleDownload() {
    if (!url || queuing || downloadActive) return;
    setPresetMenuOpen(false);
    setQueuing(true);
    try {
      const job = await submitDownload(url, selectedPreset, {
        title: meta?.title ?? undefined,
        channel: meta?.channel ?? (channelParam || undefined),
      });
      setActiveJobId(job.id);
      swapPendingRef.current = false;
      showToast(STAY_DOWNLOAD_TOAST);
    } catch (err: unknown) {
      const detail =
        err instanceof Error ? err.message : "Could not start download";
      showToast(detail);
    } finally {
      setQueuing(false);
    }
  }

  function selectPreset(preset: string) {
    userPickedPresetRef.current = true;
    setSelectedPreset(preset);
    setPresetMenuOpen(false);
  }

  const presetOptions = useMemo(() => {
    if (availablePresets.length > 0) return availablePresets;
    return ["best"];
  }, [availablePresets]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoadingIndicator label="Loading preview…" />
      </div>
    );
  }

  if (error || !meta) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-16 text-center">
        <p className="text-gray-300">{error || "Preview unavailable"}</p>
        <Link to={backHref} className="text-sm text-accent hover:underline">
          ← Back
        </Link>
      </div>
    );
  }

  const previewRes = formatResolution(meta.preview_height);
  const channelName = meta.channel || channelParam;

  return (
    <div
      className={`mx-auto max-w-5xl xl:max-w-6xl 2xl:max-w-7xl ${isWide ? "-mt-6" : ""}`}
    >
      <div className={playerOuterClass}>
        <div className="w-full">
          <div ref={dockRef} className="aspect-video w-full bg-black" />
        </div>
      </div>

      <div className={isWide ? "px-3 md:px-6" : undefined}>
        <div className="mt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-xl font-bold text-gray-100">
              {meta.title || "Untitled"}
            </h1>
            <Link
              to={backHref}
              className="shrink-0 text-sm text-gray-400 hover:text-accent"
            >
              ← Back
            </Link>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-400">
            {channelName && (
              <Link
                to={`/?channel=${encodeURIComponent(channelName)}&tab=feed`}
                className="font-medium text-accent hover:underline"
              >
                {channelName}
              </Link>
            )}
            {meta.duration != null && (
              <span>{formatDuration(meta.duration)}</span>
            )}
            {meta.view_count != null && (
              <span>{formatViewCount(meta.view_count)}</span>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5">
            <span className="text-xs font-bold uppercase tracking-wide text-amber-300">
              Preview
              {previewRes ? ` · ${previewRes}` : ""}
            </span>
            <HelpTip text={PREVIEW_QUALITY_TIP}>
              <button
                type="button"
                className="flex h-4 w-4 items-center justify-center rounded-full border border-amber-500/50 text-[10px] font-bold text-amber-300/90 hover:bg-amber-500/20"
                aria-label="Why is preview quality limited?"
              >
                ?
              </button>
            </HelpTip>
          </div>
          {meta.library_video_id != null && !downloadActive && (
            <Link
              to={`/watch/${meta.library_video_id}`}
              className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/40 hover:bg-emerald-500/25"
            >
              Already in library — Watch
            </Link>
          )}
          {meta.library_video_id == null && !downloadActive && (
            <div className="relative" ref={downloadMenuRef}>
              <div className="inline-flex overflow-hidden rounded-lg bg-accent text-xs font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-60">
                <button
                  type="button"
                  onClick={() => void handleDownload()}
                  disabled={queuing}
                  className="px-3 py-1.5 disabled:opacity-60"
                >
                  {queuing ? "Queuing…" : downloadButtonLabel(selectedPreset)}
                </button>
                <button
                  type="button"
                  onClick={() => setPresetMenuOpen((v) => !v)}
                  disabled={queuing}
                  aria-label="Choose download quality"
                  aria-expanded={presetMenuOpen}
                  aria-haspopup="listbox"
                  className="border-l border-ink-950/25 px-2 py-1.5 disabled:opacity-60"
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
                    <li key={p} role="option" aria-selected={p === selectedPreset}>
                      <button
                        type="button"
                        onClick={() => selectPreset(p)}
                        className={`flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-xs hover:bg-ink-800 ${
                          p === selectedPreset
                            ? "font-semibold text-accent"
                            : "text-gray-200"
                        }`}
                      >
                        <span>{presetOptionLabel(p, presetSizes)}</span>
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
          {downloadActive && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-gray-300">
                {live?.status === "processing"
                  ? "Processing…"
                  : live?.status === "queued"
                    ? "Queued…"
                    : `Downloading ${downloadPercent}%`}
              </span>
              <div className="w-36">
                <div className="h-1 w-full overflow-hidden rounded-full bg-ink-800">
                  <div
                    className="h-full rounded-full bg-accent/70 transition-all duration-300"
                    style={{ width: `${downloadPercent}%` }}
                  />
                </div>
                {(live?.downloaded_bytes != null ||
                  live?.total_bytes != null) && (
                  <p className="mt-1 text-[10px] text-gray-600">
                    {live.downloaded_bytes != null
                      ? formatSize(live.downloaded_bytes)
                      : "…"}
                    {live.total_bytes != null
                      ? ` / ${formatSize(live.total_bytes)}`
                      : ""}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>


        {(showDescriptionPanel || chapters.length > 0) && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() =>
                updateSettings({
                  descriptionExpanded: !settings.descriptionExpanded,
                })
              }
              className="ui-panel-toggle ui-interactive flex w-full items-center justify-between py-2 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-accent"
            >
              <span className="ui-panel-toggle-press inline-flex items-center gap-2 transition-transform">
                <span>Description</span>
                <span>{settings.descriptionExpanded ? "▲" : "▼"}</span>
              </span>
            </button>
            <Collapse open={settings.descriptionExpanded}>
              <div
                className={
                  metaSideBySide
                    ? "grid gap-4 lg:grid-cols-[minmax(0,1.75fr)_minmax(12rem,0.85fr)] lg:items-stretch"
                    : undefined
                }
              >
                {showDescriptionPanel && (
                  <div className="ui-panel isolate min-h-0 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700">
                    <div className="px-4 py-3">
                      <div
                        className={`overflow-hidden transition-[max-height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                          descExpanded ? "max-h-[80rem]" : "max-h-[7.5rem]"
                        }`}
                      >
                        <p
                          className={`text-sm text-gray-300 ${
                            descExpanded
                              ? "whitespace-pre-wrap"
                              : "line-clamp-5 whitespace-normal"
                          }`}
                        >
                          <LinkifiedText text={descriptionBody} />
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDescExpanded((v) => !v)}
                        className="mt-2 text-xs font-medium text-accent outline-none transition-[filter] hover:drop-shadow-[0_0_8px_rgb(var(--accent)/0.55)] focus:outline-none focus-visible:drop-shadow-[0_0_8px_rgb(var(--accent)/0.55)]"
                      >
                        {descExpanded ? "Show less" : "Show more"}
                      </button>
                    </div>
                  </div>
                )}
                {chapters.length > 0 && (
                  <ChaptersList
                    chapters={chapters}
                    className={metaSideBySide ? "h-full min-h-0" : ""}
                    maxHeightClass={
                      metaSideBySide
                        ? "max-h-[22rem] lg:max-h-none lg:h-full"
                        : "max-h-[22rem]"
                    }
                  />
                )}
              </div>
            </Collapse>
          </div>
        )}
      </div>
    </div>
  );
}
