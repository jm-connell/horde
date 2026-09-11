import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError, api, deviceDownloadFileUrl, triggerBrowserDownload } from "../api";
import { downloadErrorToast } from "../downloadErrors";
import { useSettings } from "../hooks/useSettings";
import { subscribeToQueue } from "../hooks/useJobEvents";
import type {
  DownloadBulkResult,
  DownloadDestination,
  DownloadJob,
  DownloadQueueStatus,
  ProgressEvent,
} from "../types";
import { useToast } from "./ToastContext";

interface SubmitOverrides {
  title?: string;
  channel?: string;
  notes?: string;
  destination?: DownloadDestination;
}

interface DownloadContextValue {
  jobs: DownloadJob[];
  progress: Record<number, ProgressEvent>;
  activeCount: number;
  queuePaused: boolean;
  submitDownload: (
    url: string,
    preset: string,
    overrides: SubmitOverrides
  ) => Promise<DownloadJob>;
  submitBulkDownloads: (
    urls: string[],
    preset: string,
    overrides?: Pick<SubmitOverrides, "destination">
  ) => Promise<DownloadBulkResult>;
  retryJob: (
    jobId: number,
    overrides?: SubmitOverrides
  ) => Promise<DownloadJob>;
  changeJobQuality: (jobId: number, preset: string) => Promise<DownloadJob>;
  updateJobOverrides: (
    jobId: number,
    overrides: SubmitOverrides & { notes?: string }
  ) => Promise<void>;
  cancelJob: (jobId: number) => Promise<void>;
  dismissJob: (jobId: number) => Promise<void>;
  dismissFinishedJobs: () => Promise<void>;
  pauseQueue: () => Promise<void>;
  resumeQueue: () => Promise<void>;
  refreshJobs: () => void;
  onJobCompleted: (cb: (videoId: number | null, event?: ProgressEvent) => void) => () => void;
}

const Ctx = createContext<DownloadContextValue | null>(null);

const TERMINAL = new Set(["completed", "error", "cancelled"]);
const DUPLICATE_CODES = new Set([
  "already_queued",
  "already_downloading",
  "already_in_library",
]);

function jobStatus(job: DownloadJob, live?: ProgressEvent): string {
  // Prefer persisted terminal states over stale SSE snapshots.
  if (job.status === "completed" || job.status === "cancelled") {
    return job.status;
  }
  if (live?.status === "cancelled") {
    return "cancelled";
  }
  return live?.status ?? job.status;
}

function isActiveJob(job: DownloadJob, live?: ProgressEvent): boolean {
  const status = jobStatus(job, live);
  return status === "queued" || status === "downloading" || status === "processing";
}

function patchJobFromEvent(job: DownloadJob, event: ProgressEvent): DownloadJob {
  return {
    ...job,
    title: event.title ?? job.title,
    channel: event.channel ?? job.channel,
    thumbnail_url: event.thumbnail_url ?? job.thumbnail_url,
    quality_preset: event.quality_preset ?? job.quality_preset,
    available_presets: event.available_presets ?? job.available_presets,
  };
}

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const { showToast } = useToast();
  const [settings, updateSettings] = useSettings();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [progress, setProgress] = useState<Record<number, ProgressEvent>>({});
  const [queuePaused, setQueuePaused] = useState(false);

  const toastedErrors = useRef<Set<number>>(new Set());
  const toastedCancelled = useRef<Set<number>>(new Set());
  const toastedSkipped = useRef<Set<number>>(new Set());
  const deviceSaved = useRef<Set<number>>(new Set());
  const restartingJobs = useRef<Set<number>>(new Set());
  const completionListeners = useRef<
    Set<(videoId: number | null, event?: ProgressEvent) => void>
  >(new Set());

  const refreshJob = useCallback((jobId: number) => {
    api
      .getJob(jobId)
      .then((fresh) => {
        setJobs((prev) => prev.map((j) => (j.id === fresh.id ? fresh : j)));
        if (fresh.status === "completed") {
          setProgress((prev) => ({
            ...prev,
            [jobId]: {
              status: "completed",
              progress: 100,
              video_id: fresh.video_id ?? undefined,
              title: fresh.title ?? undefined,
              destination: fresh.destination,
            },
          }));
          if (
            fresh.destination === "device" &&
            !deviceSaved.current.has(jobId)
          ) {
            deviceSaved.current.add(jobId);
            triggerBrowserDownload(deviceDownloadFileUrl(jobId));
          }
        }
      })
      .catch(() => undefined);
  }, []);

  const maybeSaveDeviceFile = useCallback((jobId: number, destination?: string) => {
    if (destination !== "device") return;
    if (deviceSaved.current.has(jobId)) return;
    deviceSaved.current.add(jobId);
    triggerBrowserDownload(deviceDownloadFileUrl(jobId));
  }, []);

  const handleQueueEvent = useCallback(
    (event: ProgressEvent) => {
      const jobId = event.job_id;
      if (jobId == null) return;

      if (event.status === "skipped" && event.reason === "shorts") {
        if (!toastedSkipped.current.has(jobId)) {
          toastedSkipped.current.add(jobId);
          showToast("YouTube Shorts are not downloaded");
        }
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        setProgress((prev) => {
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
        return;
      }

      if (
        restartingJobs.current.has(jobId) &&
        event.status === "cancelled"
      ) {
        return;
      }

      setProgress((prev) => ({
        ...prev,
        [jobId]: { ...prev[jobId], ...event },
      }));
      if (
        event.title ||
        event.channel ||
        event.thumbnail_url ||
        event.quality_preset ||
        event.available_presets
      ) {
        setJobs((prev) =>
          prev.map((j) => (j.id === jobId ? patchJobFromEvent(j, event) : j))
        );
      }

      if (!TERMINAL.has(event.status)) return;
      refreshJob(jobId);
      if (event.status === "completed") {
        const videoId = event.video_id ?? null;
        maybeSaveDeviceFile(jobId, event.destination);
        completionListeners.current.forEach((cb) => cb(videoId, event));
        if (event.quality_warning) {
          showToast(event.quality_warning);
        }
        return;
      }
      if (event.status === "cancelled") {
        if (
          !restartingJobs.current.has(jobId) &&
          !toastedCancelled.current.has(jobId)
        ) {
          toastedCancelled.current.add(jobId);
          showToast("Cancelled");
        }
        return;
      }
      if (event.status === "error" && !toastedErrors.current.has(jobId)) {
        if (restartingJobs.current.has(jobId)) return;
        toastedErrors.current.add(jobId);
        showToast(downloadErrorToast(event.error_kind, event.error));
      }
    },
    [refreshJob, showToast, maybeSaveDeviceFile]
  );

  const handleQueueEventRef = useRef(handleQueueEvent);
  handleQueueEventRef.current = handleQueueEvent;

  const refreshJobs = useCallback(() => {
    api
      .listJobs()
      .then(setJobs)
      .catch(() => undefined);
  }, []);

  const syncQueue = useCallback(() => {
    api
      .getQueueStatus()
      .then((s: DownloadQueueStatus) => setQueuePaused(s.paused))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api.listJobs().then(setJobs).catch(() => undefined);
    syncQueue();
    const close = subscribeToQueue((event) => handleQueueEventRef.current(event));
    const poll = setInterval(refreshJobs, 10000);
    const queuePoll = setInterval(syncQueue, 5000);
    return () => {
      clearInterval(poll);
      clearInterval(queuePoll);
      close();
    };
  }, [refreshJobs, syncQueue]);

  const submitDownload = useCallback(
    async (url: string, preset: string, overrides: SubmitOverrides) => {
      try {
        const job = await api.createDownload(url, preset, {
          title_override: overrides.title?.trim() || undefined,
          channel_override: overrides.channel?.trim() || undefined,
          notes_pending: overrides.notes?.trim() || undefined,
          normalize_volume: settings.normalizeVolumeOnDownload,
          video_codec: settings.downloadVideoCodec,
          destination: overrides.destination ?? "library",
        });
        setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
        syncQueue();
        if (overrides.channel?.trim()) {
          updateSettings({ lastCustomChannel: overrides.channel.trim() });
        }
        return job;
      } catch (err) {
        if (err instanceof ApiError && err.code && DUPLICATE_CODES.has(err.code)) {
          showToast(err.message);
        }
        throw err;
      }
    },
    [updateSettings, settings.normalizeVolumeOnDownload, settings.downloadVideoCodec, syncQueue, showToast]
  );

  const submitBulkDownloads = useCallback(
    async (
      urls: string[],
      preset: string,
      overrides: Pick<SubmitOverrides, "destination"> = {}
    ) => {
      const result = await api.bulkCreateDownloads(urls, preset, {
        destination: overrides.destination ?? "library",
        normalize_volume: settings.normalizeVolumeOnDownload,
        video_codec: settings.downloadVideoCodec,
      });
      setJobs((prev) => {
        const ids = new Set(result.jobs.map((j) => j.id));
        return [...result.jobs, ...prev.filter((j) => !ids.has(j.id))];
      });
      syncQueue();
      return result;
    },
    [settings.normalizeVolumeOnDownload, settings.downloadVideoCodec, syncQueue]
  );

  const retryJob = useCallback(
    async (jobId: number, overrides: SubmitOverrides = {}) => {
      toastedErrors.current.delete(jobId);
      toastedCancelled.current.delete(jobId);
      deviceSaved.current.delete(jobId);
      setProgress((prev) => ({
        ...prev,
        [jobId]: {
          status: "queued",
          progress: 0,
          title: overrides.title?.trim() || prev[jobId]?.title,
          channel: overrides.channel?.trim() || prev[jobId]?.channel,
          destination: overrides.destination ?? prev[jobId]?.destination,
        },
      }));
      try {
        const job = await api.retryJob(jobId, {
          title_override: overrides.title?.trim() || undefined,
          channel_override: overrides.channel?.trim() || undefined,
          notes_pending: overrides.notes?.trim() || undefined,
        });
        setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
        syncQueue();
        return job;
      } catch (err) {
        setProgress((prev) => {
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
        refreshJob(jobId);
        throw err;
      }
    },
    [refreshJob, syncQueue]
  );

  const changeJobQuality = useCallback(
    async (jobId: number, preset: string) => {
      restartingJobs.current.add(jobId);
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? {
                ...j,
                quality_preset: preset,
                progress: 0,
                status: j.status === "downloading" ? "queued" : j.status,
              }
            : j
        )
      );
      setProgress((prev) => ({
        ...prev,
        [jobId]: {
          ...prev[jobId],
          status: "queued",
          progress: 0,
        },
      }));
      try {
        const job = await api.changeJobQuality(jobId, preset);
        setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
        syncQueue();
        return job;
      } catch (err) {
        restartingJobs.current.delete(jobId);
        refreshJob(jobId);
        throw err;
      } finally {
        window.setTimeout(() => restartingJobs.current.delete(jobId), 10000);
      }
    },
    [refreshJob, syncQueue]
  );

  const updateJobOverrides = useCallback(
    async (
      jobId: number,
      overrides: SubmitOverrides & { notes?: string }
    ) => {
      const updated = await api.updateJob(jobId, {
        title_override: overrides.title?.trim() || undefined,
        channel_override: overrides.channel?.trim() || undefined,
        notes_pending: overrides.notes?.trim() || undefined,
      });
      setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
    },
    []
  );

  const cancelJob = useCallback(
    async (jobId: number) => {
      setProgress((prev) => ({
        ...prev,
        [jobId]: { status: "cancelled", error: "Cancelled", progress: 0 },
      }));
      const updated = await api.cancelJob(jobId);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
      if (updated.status !== "cancelled") {
        setProgress((prev) => ({
          ...prev,
          [jobId]: { status: "cancelled", error: "Cancelled", progress: 0 },
        }));
      }
      syncQueue();
    },
    [syncQueue]
  );

  const dismissJob = useCallback(async (jobId: number) => {
    await api.dismissJob(jobId);
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    setProgress((prev) => {
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
  }, []);

  const dismissFinishedJobs = useCallback(async () => {
    await api.dismissFinished();
    setJobs((prev) =>
      prev.filter(
        (j) =>
          j.status !== "completed" &&
          j.status !== "error" &&
          j.status !== "cancelled"
      )
    );
    setProgress((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const id = Number(key);
        const ev = next[id];
        if (
          ev?.status === "completed" ||
          ev?.status === "error" ||
          ev?.status === "cancelled"
        ) {
          delete next[id];
        }
      }
      return next;
    });
  }, []);

  const pauseQueue = useCallback(async () => {
    const s = await api.pauseQueue();
    setQueuePaused(s.paused);
    refreshJobs();
  }, [refreshJobs]);

  const resumeQueue = useCallback(async () => {
    const s = await api.resumeQueue();
    setQueuePaused(s.paused);
    refreshJobs();
  }, [refreshJobs]);

  const onJobCompleted = useCallback(
    (cb: (videoId: number | null, event?: ProgressEvent) => void) => {
      completionListeners.current.add(cb);
      return () => completionListeners.current.delete(cb);
    },
    []
  );

  const activeCount = jobs.filter((j) => isActiveJob(j, progress[j.id])).length;

  // Memoized so an SSE tick for one job doesn't re-render every useDownloads() consumer.
  const value: DownloadContextValue = useMemo(
    () => ({
      jobs,
      progress,
      activeCount,
      queuePaused,
      submitDownload,
      submitBulkDownloads,
      retryJob,
      changeJobQuality,
      updateJobOverrides,
      cancelJob,
      dismissJob,
      dismissFinishedJobs,
      pauseQueue,
      resumeQueue,
      refreshJobs,
      onJobCompleted,
    }),
    [
      jobs,
      progress,
      activeCount,
      queuePaused,
      submitDownload,
      submitBulkDownloads,
      retryJob,
      changeJobQuality,
      updateJobOverrides,
      cancelJob,
      dismissJob,
      dismissFinishedJobs,
      pauseQueue,
      resumeQueue,
      refreshJobs,
      onJobCompleted,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDownloads(): DownloadContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDownloads must be used within DownloadProvider");
  return ctx;
}

export { isActiveJob, jobStatus };
