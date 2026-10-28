import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { describeError } from "../apiErrors";
import {
  ApiError,
  api,
  deviceDownloadFileUrl,
  triggerBrowserDownload,
} from "../api";
import { downloadErrorToast } from "../downloadErrors";
import { offlineManager } from "../offline/manager";
import { useSettings } from "../hooks/useSettings";
import { queryKeys } from "../queries/keys";
import { subscribeToQueue } from "../hooks/useJobEvents";
import type {
  DownloadBulkResult,
  DownloadDestination,
  DownloadJob,
  DownloadQueueStatus,
  ProgressEvent,
} from "../types";
import { heldReasonFor } from "../components/downloadJobCardState";
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
  /** Set while queued downloads wait for disk space: the sentence to show. */
  queueHeldReason: string | null;
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
  onJobCompleted: (
    cb: (videoId: number | null, event?: ProgressEvent) => void
  ) => () => void;
}

const Ctx = createContext<DownloadContextValue | null>(null);

const NO_JOBS: DownloadJob[] = [];
const NO_PROGRESS: Record<number, ProgressEvent> = {};
/** Only while the SSE stream is down. */
const JOBS_FALLBACK_POLL_MS = 10_000;
const QUEUE_POLL_MS = 30_000;
const noop = () => undefined;

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
  return (
    status === "queued" || status === "downloading" || status === "processing"
  );
}

function patchJobFromEvent(
  job: DownloadJob,
  event: ProgressEvent
): DownloadJob {
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
  const { showToast, showError } = useToast();
  const [settings, updateSettings] = useSettings();
  const queryClient = useQueryClient();
  // The queue SSE stream is the primary feed; polling only covers it being down.
  const [streamConnected, setStreamConnected] = useState(false);

  const jobsQuery = useQuery({
    queryKey: queryKeys.downloads.jobs,
    queryFn: ({ signal }) => api.listJobs({ signal }),
    // Poll while the stream is down, and also when the last read failed: the
    // stream only pushes changes, so a list that never loaded would stay empty.
    refetchInterval: (query) =>
      streamConnected && query.state.status !== "error"
        ? false
        : JOBS_FALLBACK_POLL_MS,
  });
  const jobs = jobsQuery.data ?? NO_JOBS;

  // Live progress per job: written only by SSE events and optimistic updates,
  // never fetched, so the query has no queryFn.
  const progress =
    useQuery({
      queryKey: queryKeys.downloads.progress,
      queryFn: skipToken,
      initialData: NO_PROGRESS,
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? NO_PROGRESS;

  // Pause/resume is not pushed over SSE, so another device's change arrives by
  // this slow refetch (and on window focus).
  const queuePaused =
    useQuery({
      queryKey: queryKeys.downloads.queue,
      queryFn: ({ signal }) => api.getQueueStatus({ signal }),
      refetchInterval: QUEUE_POLL_MS,
      refetchOnWindowFocus: true,
    }).data?.paused ?? false;

  const setJobs = useCallback(
    (update: (prev: DownloadJob[]) => DownloadJob[]) => {
      queryClient.setQueryData<DownloadJob[]>(
        queryKeys.downloads.jobs,
        (prev) => update(prev ?? [])
      );
    },
    [queryClient]
  );
  const setProgress = useCallback(
    (
      update: (
        prev: Record<number, ProgressEvent>
      ) => Record<number, ProgressEvent>
    ) => {
      queryClient.setQueryData<Record<number, ProgressEvent>>(
        queryKeys.downloads.progress,
        (prev) => update(prev ?? NO_PROGRESS)
      );
    },
    [queryClient]
  );

  const toastedErrors = useRef<Set<number>>(new Set());
  const toastedCancelled = useRef<Set<number>>(new Set());
  const toastedSkipped = useRef<Set<number>>(new Set());
  const deviceSaved = useRef<Set<number>>(new Set());
  const restartingJobs = useRef<Set<number>>(new Set());
  const completionListeners = useRef<
    Set<(videoId: number | null, event?: ProgressEvent) => void>
  >(new Set());

  const saveDeviceJob = useCallback(
    (job: DownloadJob) => {
      deviceSaved.current.add(job.id);
      if (offlineManager.getSnapshot().unsupported) {
        triggerBrowserDownload(deviceDownloadFileUrl(job.id));
        return;
      }
      showToast(
        `Saving \u201c${job.title || "video"}\u201d for offline viewing`
      );
      offlineManager
        .downloadJob(job)
        .catch((err) =>
          showError(`Could not save for offline: ${describeError(err)}`)
        );
    },
    [showToast, showError]
  );

  /** Read the job list again unless a read is already in flight. */
  const refreshJobs = useCallback(() => {
    void queryClient.refetchQueries(
      { queryKey: queryKeys.downloads.jobs, exact: true },
      { cancelRefetch: false }
    );
  }, [queryClient]);

  const syncQueue = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.downloads.queue,
    });
  }, [queryClient]);

  const refreshJob = useCallback(
    (jobId: number) => {
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
              saveDeviceJob(fresh);
            }
          }
        })
        .catch(() => undefined);
    },
    [saveDeviceJob, setJobs, setProgress]
  );

  const maybeSaveDeviceFile = useCallback(
    (jobId: number, destination?: string) => {
      if (destination !== "device") return;
      if (deviceSaved.current.has(jobId)) return;
      api
        .getJob(jobId)
        .then((fresh) => {
          if (deviceSaved.current.has(jobId)) return;
          if (fresh.status === "completed") saveDeviceJob(fresh);
        })
        .catch(() => undefined);
    },
    [saveDeviceJob]
  );

  const handleQueueEvent = useCallback(
    (event: ProgressEvent) => {
      const jobId = event.job_id;
      if (jobId == null) return;

      if (event.status === "skipped" && event.reason === "shorts") {
        if (!toastedSkipped.current.has(jobId)) {
          toastedSkipped.current.add(jobId);
          showToast("Don’t watch shorts");
        }
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        setProgress((prev) => {
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
        return;
      }

      if (restartingJobs.current.has(jobId) && event.status === "cancelled") {
        return;
      }

      setProgress((prev) => ({
        ...prev,
        [jobId]: { ...prev[jobId], ...event },
      }));
      const cached = queryClient.getQueryData<DownloadJob[]>(
        queryKeys.downloads.jobs
      );
      if (cached && !cached.some((j) => j.id === jobId)) {
        // A job another client added: the event is all we know of it so far.
        refreshJobs();
      } else if (
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
    [
      queryClient,
      refreshJob,
      refreshJobs,
      showToast,
      maybeSaveDeviceFile,
      setJobs,
      setProgress,
    ]
  );

  const handleQueueEventRef = useRef(handleQueueEvent);
  handleQueueEventRef.current = handleQueueEvent;

  useEffect(() => {
    let wasDown = false;
    return subscribeToQueue(
      (event) => handleQueueEventRef.current(event),
      (open) => {
        setStreamConnected(open);
        if (!open) {
          wasDown = true;
        } else if (wasDown) {
          // Events were missed while the stream was down: read the lists again.
          wasDown = false;
          void queryClient.invalidateQueries({
            queryKey: queryKeys.downloads.jobs,
          });
          syncQueue();
        }
      }
    );
  }, [queryClient, syncQueue]);

  const { mutateAsync: submitAsync } = useMutation({
    mutationFn: (v: {
      url: string;
      preset: string;
      overrides: SubmitOverrides;
    }) =>
      api.createDownload(v.url, v.preset, {
        title_override: v.overrides.title?.trim() || undefined,
        channel_override: v.overrides.channel?.trim() || undefined,
        notes_pending: v.overrides.notes?.trim() || undefined,
        normalize_volume: settings.normalizeVolumeOnDownload,
        video_codec: settings.downloadVideoCodec,
        destination: v.overrides.destination ?? "library",
      }),
    onSuccess: (job, v) => {
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      syncQueue();
      if (v.overrides.channel?.trim()) {
        updateSettings({ lastCustomChannel: v.overrides.channel.trim() });
      }
    },
    onError: (err) => {
      // Duplicates are expected, so say so; the caller shows any other error.
      if (
        err instanceof ApiError &&
        err.code &&
        DUPLICATE_CODES.has(err.code)
      ) {
        showToast(err.message);
      }
    },
  });

  const { mutateAsync: bulkAsync } = useMutation({
    mutationFn: (v: {
      urls: string[];
      preset: string;
      destination?: DownloadDestination;
    }) =>
      api.bulkCreateDownloads(v.urls, v.preset, {
        destination: v.destination ?? "library",
        normalize_volume: settings.normalizeVolumeOnDownload,
        video_codec: settings.downloadVideoCodec,
      }),
    onSuccess: (result) => {
      setJobs((prev) => {
        const ids = new Set(result.jobs.map((j) => j.id));
        return [...result.jobs, ...prev.filter((j) => !ids.has(j.id))];
      });
      syncQueue();
    },
  });

  const { mutateAsync: retryAsync } = useMutation({
    mutationFn: (v: { jobId: number; overrides: SubmitOverrides }) =>
      api.retryJob(v.jobId, {
        title_override: v.overrides.title?.trim() || undefined,
        channel_override: v.overrides.channel?.trim() || undefined,
        notes_pending: v.overrides.notes?.trim() || undefined,
      }),
    onMutate: ({ jobId, overrides }) => {
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
    },
    onSuccess: (job) => {
      setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
      syncQueue();
    },
    onError: (_err, { jobId }) => {
      setProgress((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
      refreshJob(jobId);
    },
  });

  const { mutateAsync: qualityAsync } = useMutation({
    mutationFn: (v: { jobId: number; preset: string }) =>
      api.changeJobQuality(v.jobId, v.preset),
    onMutate: ({ jobId, preset }) => {
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
        [jobId]: { ...prev[jobId], status: "queued", progress: 0 },
      }));
    },
    onSuccess: (job) => {
      setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
      syncQueue();
    },
    onError: (_err, { jobId }) => {
      restartingJobs.current.delete(jobId);
      refreshJob(jobId);
    },
    onSettled: (_job, _err, { jobId }) => {
      // Late events of the superseded attempt are ignored for a while.
      window.setTimeout(() => restartingJobs.current.delete(jobId), 10000);
    },
  });

  const { mutateAsync: overridesAsync } = useMutation({
    mutationFn: (v: {
      jobId: number;
      overrides: SubmitOverrides & { notes?: string };
    }) =>
      api.updateJob(v.jobId, {
        title_override: v.overrides.title?.trim() || undefined,
        channel_override: v.overrides.channel?.trim() || undefined,
        notes_pending: v.overrides.notes?.trim() || undefined,
      }),
    onSuccess: (updated, { jobId }) =>
      setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j))),
  });

  // The remaining actions have no caller that reports a failure, so their
  // mutations do (and the wrapper below resolves instead of throwing).
  const { mutateAsync: cancelAsync } = useMutation({
    mutationFn: (jobId: number) => api.cancelJob(jobId),
    onMutate: (jobId) => {
      setProgress((prev) => ({
        ...prev,
        [jobId]: { status: "cancelled", error: "Cancelled", progress: 0 },
      }));
    },
    onSuccess: (updated, jobId) => {
      setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
      syncQueue();
    },
    onError: (err, jobId) => {
      setProgress((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
      refreshJob(jobId);
      showError(`Could not cancel the download: ${describeError(err)}`);
    },
  });

  const { mutateAsync: dismissAsync } = useMutation({
    mutationFn: (jobId: number) => api.dismissJob(jobId),
    onSuccess: (_void, jobId) => {
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
      setProgress((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
    },
    onError: (err) =>
      showError(`Could not remove the download: ${describeError(err)}`),
  });

  const { mutateAsync: dismissFinishedAsync } = useMutation({
    mutationFn: () => api.dismissFinished(),
    onSuccess: () => {
      setJobs((prev) => prev.filter((j) => !TERMINAL.has(j.status)));
      setProgress((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          const id = Number(key);
          const ev = next[id];
          if (ev && TERMINAL.has(ev.status)) delete next[id];
        }
        return next;
      });
    },
    onError: (err) =>
      showError(`Could not clear finished downloads: ${describeError(err)}`),
  });

  const { mutateAsync: queueAsync } = useMutation({
    mutationFn: (action: "pause" | "resume") =>
      action === "pause" ? api.pauseQueue() : api.resumeQueue(),
    onSuccess: (status) => {
      queryClient.setQueryData<DownloadQueueStatus>(
        queryKeys.downloads.queue,
        status
      );
      refreshJobs();
    },
    onError: (err) =>
      showError(`Could not change the download queue: ${describeError(err)}`),
  });

  const submitDownload = useCallback(
    (url: string, preset: string, overrides: SubmitOverrides) =>
      submitAsync({ url, preset, overrides }),
    [submitAsync]
  );
  const submitBulkDownloads = useCallback(
    (
      urls: string[],
      preset: string,
      overrides: Pick<SubmitOverrides, "destination"> = {}
    ) =>
      bulkAsync({
        urls,
        preset,
        destination: overrides.destination,
      }),
    [bulkAsync]
  );
  const retryJob = useCallback(
    (jobId: number, overrides: SubmitOverrides = {}) =>
      retryAsync({ jobId, overrides }),
    [retryAsync]
  );
  const changeJobQuality = useCallback(
    (jobId: number, preset: string) => qualityAsync({ jobId, preset }),
    [qualityAsync]
  );
  const updateJobOverrides = useCallback(
    async (jobId: number, overrides: SubmitOverrides & { notes?: string }) => {
      await overridesAsync({ jobId, overrides });
    },
    [overridesAsync]
  );
  const cancelJob = useCallback(
    (jobId: number) => cancelAsync(jobId).then(noop, noop),
    [cancelAsync]
  );
  const dismissJob = useCallback(
    (jobId: number) => dismissAsync(jobId).then(noop, noop),
    [dismissAsync]
  );
  const dismissFinishedJobs = useCallback(
    () => dismissFinishedAsync().then(noop, noop),
    [dismissFinishedAsync]
  );
  const pauseQueue = useCallback(
    () => queueAsync("pause").then(noop, noop),
    [queueAsync]
  );
  const resumeQueue = useCallback(
    () => queueAsync("resume").then(noop, noop),
    [queueAsync]
  );

  const onJobCompleted = useCallback(
    (cb: (videoId: number | null, event?: ProgressEvent) => void) => {
      completionListeners.current.add(cb);
      return () => completionListeners.current.delete(cb);
    },
    []
  );

  const activeCount = jobs.filter((j) => isActiveJob(j, progress[j.id])).length;
  const queueHeldReason =
    jobs
      .map((j) =>
        heldReasonFor(
          jobStatus(j, progress[j.id]),
          j.paused,
          progress[j.id]?.held_reason,
          j.held_reason
        )
      )
      .find((reason) => reason !== null) ?? null;

  // Memoized so an SSE tick for one job doesn't re-render every useDownloads() consumer.
  const value: DownloadContextValue = useMemo(
    () => ({
      jobs,
      progress,
      activeCount,
      queuePaused,
      queueHeldReason,
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
      queueHeldReason,
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
  if (!ctx)
    throw new Error("useDownloads must be used within DownloadProvider");
  return ctx;
}

export { isActiveJob, jobStatus };
