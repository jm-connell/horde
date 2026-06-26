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
import type { DownloadJob, ProgressEvent } from "../types";

interface SubmitOverrides {
  title?: string;
  channel?: string;
}

interface DownloadContextValue {
  jobs: DownloadJob[];
  progress: Record<number, ProgressEvent>;
  activeCount: number;
  submitDownload: (
    url: string,
    preset: string,
    overrides: SubmitOverrides
  ) => Promise<DownloadJob>;
  updateJobOverrides: (
    jobId: number,
    overrides: SubmitOverrides
  ) => Promise<void>;
  onJobCompleted: (cb: (videoId: number | null) => void) => () => void;
}

const Ctx = createContext<DownloadContextValue | null>(null);

const TERMINAL = new Set(["completed", "error"]);

function isActive(job: DownloadJob): boolean {
  return job.status === "queued" || job.status === "downloading";
}

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [, updateSettings] = useSettings();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [progress, setProgress] = useState<Record<number, ProgressEvent>>({});

  const sources = useRef<Map<number, () => void>>(new Map());
  const completionListeners = useRef<Set<(videoId: number | null) => void>>(
    new Set()
  );

  const refreshJob = useCallback((jobId: number) => {
    api
      .getJob(jobId)
      .then((fresh) =>
        setJobs((prev) =>
          prev.map((j) => (j.id === fresh.id ? fresh : j))
        )
      )
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
            completionListeners.current.forEach((cb) => cb(videoId));
          }
        }
      });
      sources.current.set(jobId, close);
    },
    [refreshJob]
  );

  // Hydrate from the backend on mount and resume listening to active jobs.
  useEffect(() => {
    api
      .listJobs()
      .then((all) => {
        setJobs(all);
        all.filter(isActive).forEach((j) => subscribe(j.id));
      })
      .catch(() => undefined);
    const current = sources.current;
    return () => {
      current.forEach((close) => close());
      current.clear();
    };
  }, [subscribe]);

  const submitDownload = useCallback(
    async (url: string, preset: string, overrides: SubmitOverrides) => {
      const job = await api.createDownload(url, preset, {
        title_override: overrides.title?.trim() || undefined,
        channel_override: overrides.channel?.trim() || undefined,
      });
      setJobs((prev) => [job, ...prev]);
      subscribe(job.id);
      if (overrides.channel?.trim()) {
        updateSettings({ lastCustomChannel: overrides.channel.trim() });
      }
      return job;
    },
    [subscribe, updateSettings]
  );

  const updateJobOverrides = useCallback(
    async (jobId: number, overrides: SubmitOverrides) => {
      const updated = await api.updateJob(jobId, {
        title_override: overrides.title?.trim() || undefined,
        channel_override: overrides.channel?.trim() || undefined,
      });
      setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
    },
    []
  );

  const onJobCompleted = useCallback(
    (cb: (videoId: number | null) => void) => {
      completionListeners.current.add(cb);
      return () => completionListeners.current.delete(cb);
    },
    []
  );

  const activeCount = jobs.filter((j) => {
    const live = progress[j.id];
    const status = live?.status ?? j.status;
    return status === "queued" || status === "downloading" || status === "processing";
  }).length;

  const value: DownloadContextValue = {
    jobs,
    progress,
    activeCount,
    submitDownload,
    updateJobOverrides,
    onJobCompleted,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDownloads(): DownloadContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDownloads must be used within DownloadProvider");
  return ctx;
}
