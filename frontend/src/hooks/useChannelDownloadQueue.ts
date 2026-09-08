import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isActiveJob, useDownloads } from "../context/DownloadContext";
import { PRESET_ORDER, resolveQualityPreset } from "../presets";
import type { ChannelFeedEntry, DownloadJob, DownloadPreview } from "../types";

const CONFIRM_SECONDS = 5;
const DEFAULT_PRESET_KEY = "horde.channelFeed.defaultPreset";

export interface PendingChannelDownload {
  tempId: number;
  entry: ChannelFeedEntry;
  preset: string;
  title: string;
  channel: string;
  notes: string;
  preview: DownloadPreview | null;
  previewLoading: boolean;
  secondsLeft: number;
  submitting: boolean;
}

/** Confirm pending feed downloads (e.g. on navigate) instead of dropping them. */
export function confirmPendingOnLeave(
  pending: ReadonlyArray<Pick<PendingChannelDownload, "tempId" | "submitting">>,
  submit: (tempId: number) => void
): void {
  for (const item of pending) {
    if (!item.submitting) submit(item.tempId);
  }
}

let nextTempId = 0;

export function channelFeedItemInLibrary(
  entry: ChannelFeedEntry,
  libraryVideoIds: ReadonlyMap<string, number>,
  jobs: readonly DownloadJob[]
): boolean {
  if (entry.in_library || entry.video_id != null) return true;
  if (libraryVideoIds.has(entry.url)) return true;
  return jobs.some(
    (j) =>
      j.url === entry.url &&
      j.status === "completed" &&
      j.video_id != null &&
      !j.video_missing &&
      j.destination !== "device"
  );
}

export function channelFeedItemDownloading(
  entry: ChannelFeedEntry,
  pendingUrls: ReadonlySet<string>,
  queuedUrls: ReadonlySet<string>,
  jobs: readonly DownloadJob[]
): boolean {
  if (pendingUrls.has(entry.url)) return true;
  if (queuedUrls.has(entry.url)) return true;
  return jobs.some((j) => j.url === entry.url && isActiveJob(j));
}

function loadDefaultPreset(): string {
  try {
    const raw = localStorage.getItem(DEFAULT_PRESET_KEY);
    return raw?.trim() || "best";
  } catch {
    return "best";
  }
}

export function useChannelDownloadQueue(channelName: string) {
  const { submitDownload, jobs } = useDownloads();
  const [defaultPreset, setDefaultPresetState] = useState(loadDefaultPreset);
  const [allPresets, setAllPresets] = useState<string[]>([...PRESET_ORDER]);
  const [pending, setPending] = useState<PendingChannelDownload[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [queuedUrls, setQueuedUrls] = useState<Set<string>>(new Set());
  const [libraryVideoIds, setLibraryVideoIds] = useState<Map<string, number>>(
    new Map()
  );
  const intervalsRef = useRef<Map<number, ReturnType<typeof setInterval>>>(
    new Map()
  );
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const submittingIdsRef = useRef(new Set<number>());
  const pendingUrlsRef = useRef(new Set<string>());

  const setDefaultPreset = useCallback((preset: string) => {
    setDefaultPresetState(preset);
    try {
      localStorage.setItem(DEFAULT_PRESET_KEY, preset);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    api.listPresets().then(setAllPresets).catch(() => undefined);
  }, []);

  useEffect(() => {
    setLibraryVideoIds((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const job of jobs) {
        if (
          job.status === "completed" &&
          job.video_id != null &&
          job.url &&
          !job.video_missing &&
          job.destination !== "device"
        ) {
          if (next.get(job.url) !== job.video_id) {
            next.set(job.url, job.video_id);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
    setQueuedUrls((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set(prev);
      for (const url of prev) {
        const matching = jobs.filter((j) => j.url === url);
        if (matching.length === 0) continue;
        if (matching.some((j) => isActiveJob(j))) continue;
        if (
          matching.some(
            (j) =>
              j.status === "completed" ||
              j.status === "error" ||
              j.status === "cancelled"
          )
        ) {
          next.delete(url);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [jobs]);

  const clearTimer = useCallback((tempId: number) => {
    const handle = intervalsRef.current.get(tempId);
    if (handle) {
      clearInterval(handle);
      intervalsRef.current.delete(tempId);
    }
  }, []);

  const removePending = useCallback(
    (tempId: number) => {
      clearTimer(tempId);
      submittingIdsRef.current.delete(tempId);
      setPending((prev) => {
        const item = prev.find((p) => p.tempId === tempId);
        if (item) pendingUrlsRef.current.delete(item.entry.url);
        return prev.filter((p) => p.tempId !== tempId);
      });
    },
    [clearTimer]
  );

  const urlAlreadyQueued = useCallback(
    (url: string) => {
      if (pendingUrlsRef.current.has(url)) return true;
      if (queuedUrls.has(url)) return true;
      return jobs.some((j) => j.url === url && isActiveJob(j));
    },
    [jobs, queuedUrls]
  );

  const submitPending = useCallback(
    async (tempId: number) => {
      if (submittingIdsRef.current.has(tempId)) return;
      const item = pendingRef.current.find((p) => p.tempId === tempId);
      if (!item || item.submitting) return;

      submittingIdsRef.current.add(tempId);
      setPending((prev) =>
        prev.map((p) =>
          p.tempId === tempId ? { ...p, submitting: true } : p
        )
      );
      clearTimer(tempId);

      // Re-read latest preset/title after marking submitting.
      const latest =
        pendingRef.current.find((p) => p.tempId === tempId) ?? item;
      try {
        const detectedTitle = (latest.entry.title ?? "").trim();
        const detectedChannel = channelName.trim();
        const title = latest.title.trim();
        const channel = latest.channel.trim();
        const resolved = resolveQualityPreset(
          latest.preset,
          latest.preview?.available_presets ?? []
        );
        await submitDownload(latest.entry.url, resolved, {
          title: title && title !== detectedTitle ? title : undefined,
          channel: channel && channel !== detectedChannel ? channel : undefined,
          notes: latest.notes.trim() || undefined,
        });
        setQueuedUrls((prev) => new Set(prev).add(latest.entry.url));
        removePending(tempId);
      } catch {
        submittingIdsRef.current.delete(tempId);
        setPending((prev) =>
          prev.map((p) =>
            p.tempId === tempId ? { ...p, submitting: false } : p
          )
        );
      }
    },
    [channelName, clearTimer, removePending, submitDownload]
  );

  const submitPendingRef = useRef(submitPending);
  submitPendingRef.current = submitPending;

  const startCountdown = useCallback(
    (tempId: number) => {
      clearTimer(tempId);
      const handle = setInterval(() => {
        const item = pendingRef.current.find((p) => p.tempId === tempId);
        if (!item || item.submitting) return;
        if (item.secondsLeft <= 1) {
          clearTimer(tempId);
          void submitPending(tempId);
          return;
        }
        setPending((prev) =>
          prev.map((p) =>
            p.tempId === tempId ? { ...p, secondsLeft: p.secondsLeft - 1 } : p
          )
        );
      }, 1000);
      intervalsRef.current.set(tempId, handle);
    },
    [clearTimer, submitPending]
  );

  const queueDownload = useCallback(
    (entry: ChannelFeedEntry) => {
      if (entry.in_library) return;
      if (urlAlreadyQueued(entry.url)) return;

      pendingUrlsRef.current.add(entry.url);
      const tempId = ++nextTempId;
      const item: PendingChannelDownload = {
        tempId,
        entry,
        preset: defaultPreset,
        title: entry.title ?? "",
        channel: channelName,
        notes: "",
        preview: null,
        previewLoading: true,
        secondsLeft: CONFIRM_SECONDS,
        submitting: false,
      };
      setPending((prev) => {
        if (prev.some((p) => p.entry.url === entry.url)) return prev;
        return [...prev, item];
      });
      startCountdown(tempId);

      api
        .previewDownload(entry.url)
        .then((preview) => {
          setPending((prev) =>
            prev.map((p) =>
              p.tempId === tempId
                ? {
                    ...p,
                    preview,
                    previewLoading: false,
                    // Keep user/default preset — do not swap "best" for a capped tier.
                  }
                : p
            )
          );
        })
        .catch(() => {
          setPending((prev) =>
            prev.map((p) =>
              p.tempId === tempId ? { ...p, previewLoading: false } : p
            )
          );
        });
    },
    [channelName, defaultPreset, startCountdown, urlAlreadyQueued]
  );

  const cancelPending = useCallback(
    (tempId: number) => {
      removePending(tempId);
    },
    [removePending]
  );

  const updatePending = useCallback(
    (tempId: number, patch: Partial<PendingChannelDownload>) => {
      setPending((prev) =>
        prev.map((p) => (p.tempId === tempId ? { ...p, ...patch } : p))
      );
    },
    []
  );

  const submitNow = useCallback(
    (tempId: number) => {
      void submitPending(tempId);
    },
    [submitPending]
  );

  const isInLibrary = useCallback(
    (entry: ChannelFeedEntry) =>
      channelFeedItemInLibrary(entry, libraryVideoIds, jobs),
    [libraryVideoIds, jobs]
  );

  const isDownloading = useCallback(
    (entry: ChannelFeedEntry) => {
      const pendingUrls = new Set(pending.map((p) => p.entry.url));
      return channelFeedItemDownloading(entry, pendingUrls, queuedUrls, jobs);
    },
    [pending, queuedUrls, jobs]
  );

  const resolveVideoId = useCallback(
    (entry: ChannelFeedEntry) => {
      if (entry.video_id) return entry.video_id;
      return libraryVideoIds.get(entry.url);
    },
    [libraryVideoIds]
  );

  useEffect(() => {
    return () => {
      intervalsRef.current.forEach((handle) => clearInterval(handle));
      intervalsRef.current.clear();
      // Leaving the channel feed (route change, library home, etc.) should
      // keep queued downloads — confirm anything still counting down.
      confirmPendingOnLeave(pendingRef.current, (tempId) => {
        void submitPendingRef.current(tempId);
      });
    };
  }, []);

  return {
    defaultPreset,
    setDefaultPreset,
    allPresets,
    pending,
    editingId,
    setEditingId,
    queueDownload,
    cancelPending,
    updatePending,
    submitNow,
    isInLibrary,
    isDownloading,
    resolveVideoId,
    setLibraryVideoIds,
  };
}
