import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import { useSettings } from "../hooks/useSettings";
import { subscribeToJob } from "../hooks/useJobEvents";
import type { DownloadJob, DownloadQueueStatus, ProgressEvent } from "../types";

interface SubmitOverrides {
  title?: string;
  channel?: string;
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
  updateJobOverrides: (
    jobId: number,
    overrides: SubmitOverrides & { notes?: string }
  ) => Promise<void>;
  cancelJob: (jobId: number) => Promise<void>;
  dismissJob: (jobId: number) => Promise<void>;
  dismissFinishedJobs: () => Promise<void>;
  pauseQueue: () => Promise<void>;
  resumeQueue: () => Promise<void>;
  reorderQueue: (jobIds: number[]) => Promise<void>;
  refreshJobs: () => void;
  onJobCompleted: (cb: (videoId: number | null, event?: ProgressEvent) => void) => () => void;
}

const Ctx = createContext<DownloadContextValue | null>(null);

const TERMINAL = new Set(["completed", "error", "cancelled"]);

function jobStatus(job: DownloadJob, live?: ProgressEvent): string {
  // Prefer persisted terminal states over stale SSE snapshots.
  if (job.status === "completed" || job.status === "cancelled") {
    return job.status;
  }
  return live?.status ?? job.status;
}

function isActiveJob(job: DownloadJob, live?: ProgressEvent): boolean {
  const status = jobStatus(job, live);
  return status === "queued" || status === "downloading" || status === "processing";
}

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [settings, updateSettings] = useSettings();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [progress, setProgress] = useState<Record<number, ProgressEvent>>({});
  const [queuePaused, setQueuePaused] = useState(false);

  const sources = useRef<Map<number, () => void>>(new Map());
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
            },
          }));
        }
      })
      .catch(() => undefined);
  }, []);

  const subscribe = useCallback(
    (jobId: number) => {
      if (sources.current.has(jobId)) return;
      const close = subscribeToJob(jobId, (event) => {
        setProgress((prev) => ({ ...prev, [jobId]: event }));
        if (TERMINAL.has(event.status)) {
          sources.current.get(jobId)?.();
          sources.current.delete(jobId);
          refreshJob(jobId);
          if (event.status === "completed") {
            const videoId = event.video_id ?? null;
            completionListeners.current.forEach((cb) => cb(videoId, event));
          }
        }
      });
      sources.current.set(jobId, close);
    },
    [refreshJob]
  );

  const refreshJobs = useCallback(() => {
    api
      .listJobs()
      .then((all) => {
        setJobs(all);
        all.forEach((j) => {
          if (isActiveJob(j)) {
            subscribe(j.id);
          }
        });
      })
      .catch(() => undefined);
  }, [subscribe]);

  const syncQueue = useCallback(() => {
    api
      .getQueueStatus()
      .then((s: DownloadQueueStatus) => setQueuePaused(s.paused))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .listJobs()
      .then((all) => {
        setJobs(all);
        all.filter((j) => isActiveJob(j)).forEach((j) => subscribe(j.id));
      })
      .catch(() => undefined);
    syncQueue();
    const poll = setInterval(refreshJobs, 10000);
    const queuePoll = setInterval(syncQueue, 5000);
    const current = sources.current;
    return () => {
      clearInterval(poll);
      clearInterval(queuePoll);
      current.forEach((close) => close());
      current.clear();
    };
  }, [subscribe, refreshJobs, syncQueue]);

  const submitDownload = useCallback(
    async (url: string, preset: string, overrides: SubmitOverrides) => {
      const job = await api.createDownload(url, preset, {
        title_override: overrides.title?.trim() || undefined,
        channel_override: overrides.channel?.trim() || undefined,
        normalize_volume: settings.normalizeVolumeOnDownload,
      });
      setJobs((prev) => [job, ...prev]);
      subscribe(job.id);
      syncQueue();
      if (overrides.channel?.trim()) {
        updateSettings({ lastCustomChannel: overrides.channel.trim() });
      }
      return job;
    },
    [subscribe, updateSettings, settings.normalizeVolumeOnDownload, syncQueue]
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
      const updated = await api.cancelJob(jobId);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
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
      prev.filter((j) => j.status !== "completed" && j.status !== "error")
    );
    setProgress((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const id = Number(key);
        const ev = next[id];
        if (ev?.status === "completed" || ev?.status === "error") {
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

  const reorderQueue = useCallback(
    async (jobIds: number[]) => {
      setJobs((prev) =>
        prev.map((job) => {
          const index = jobIds.indexOf(job.id);
          if (index === -1) return job;
          return { ...job, queue_position: index };
        })
      );
      try {
        const updated = await api.reorderDownloadQueue(jobIds);
        const byId = new Map(updated.map((j) => [j.id, j]));
        setJobs((prev) => prev.map((j) => byId.get(j.id) ?? j));
      } catch {
        refreshJobs();
      }
    },
    [refreshJobs]
  );

  const onJobCompleted = useCallback(
    (cb: (videoId: number | null, event?: ProgressEvent) => void) => {
      completionListeners.current.add(cb);
      return () => completionListeners.current.delete(cb);
    },
    []
  );

  const activeCount = jobs.filter((j) => isActiveJob(j, progress[j.id])).length;

  const value: DownloadContextValue = {
    jobs,
    progress,
    activeCount,
    queuePaused,
    submitDownload,
    updateJobOverrides,
    cancelJob,
    dismissJob,
    dismissFinishedJobs,
    pauseQueue,
    resumeQueue,
    reorderQueue,
    refreshJobs,
    onJobCompleted,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDownloads(): DownloadContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDownloads must be used within DownloadProvider");
  return ctx;
}

export { isActiveJob, jobStatus };
