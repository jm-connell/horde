import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import { videoDetailQuery } from "../../queries/videos";
import { isActiveJob, useDownloads } from "../../context/DownloadContext";
import { usePlaybackActions } from "../../context/PlaybackContext";
import { useConfirm } from "../../context/ConfirmContext";
import { useToast } from "../../context/ToastContext";
import { PRESET_ORDER, resolveQualityPreset } from "../../presets";
import { downloadProgressPercent } from "../../utils";
import { isLongStream, longStreamConfirm } from "../../utils/longStream";
import { setWatchResume } from "../../utils/watchHandoff";
import type { WatchSource } from "./useWatchVideo";

const STAY_DOWNLOAD_TOAST =
  "Downloading - Video will switch to full quality when ready";

function bestAvailablePreset(presets: string[]): string {
  return resolveQualityPreset("best", presets);
}

function orderPresets(presets: string[]): string[] {
  const set = new Set(presets);
  return PRESET_ORDER.filter((p) => p !== "best" && set.has(p));
}

/**
 * Downloading the stream being previewed: quality choices, the queued job and
 * its progress, and the switch to the library copy when the job completes.
 */
export function useStreamDownload({
  source,
  setSource,
  streamUrlParam,
  libraryValid,
  channelParam,
}: {
  source: WatchSource | null;
  setSource: (source: WatchSource | null) => void;
  streamUrlParam: string;
  libraryValid: boolean;
  channelParam: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast, showError } = useToast();
  const confirm = useConfirm();
  const { onJobCompleted, submitDownload, changeJobQuality, progress, jobs } =
    useDownloads();
  const { playVideo, getStreamPosition } = usePlaybackActions();

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

  useEffect(() => {
    if (libraryValid || !streamUrlParam) return;
    setSelectedPreset("best");
    setAvailablePresets([]);
    setPresetSizes({});
    setPresetMenuOpen(false);
    userPickedPresetRef.current = false;
  }, [streamUrlParam, libraryValid]);

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
    setSource,
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

  async function handleStreamDownload() {
    if (source?.kind !== "stream" || queuing) return;
    setPresetMenuOpen(false);
    const { was_live: wasLive, duration } = source.meta;
    if (
      isLongStream(Boolean(wasLive), duration) &&
      !(await confirm(
        longStreamConfirm(duration ?? 0, presetSizes[selectedPreset])
      ))
    ) {
      return;
    }
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

  return {
    queuing,
    selectedPreset,
    setSelectedPreset,
    availablePresets,
    presetSizes,
    presetMenuOpen,
    setPresetMenuOpen,
    downloadMenuRef,
    userPickedPresetRef,
    presetOptions,
    live,
    activeJob,
    downloadPercent,
    downloadActive,
    handleStreamDownload,
    handleChangeDownloadQuality,
  };
}

export type StreamDownload = ReturnType<typeof useStreamDownload>;
