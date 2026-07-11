import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isActiveJob, useDownloads } from "../context/DownloadContext";
import { PRESET_ORDER } from "../presets";
import type { ChannelFeedEntry, DownloadPreview } from "../types";

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

let nextTempId = 0;

function loadDefaultPreset(): string {
  try {
    const raw = localStorage.getItem(DEFAULT_PRESET_KEY);
    return raw?.trim() || "best";
  } catch {
    return "best";
  }
}

export function useChannelDownloadQueue(channelName: string) {
  const { submitDownload, onJobCompleted, jobs } = useDownloads();
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
    return onJobCompleted((videoId) => {
      if (videoId == null) return;
      void videoId;
    });
  }, [onJobCompleted]);

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
        await submitDownload(latest.entry.url, latest.preset, {
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

  const startCountdown = useCallback(
    (tempId: number) => {
      clearTimer(tempId);
      const handle = setInterval(() => {
        setPending((prev) => {
          const item = prev.find((p) => p.tempId === tempId);
          if (!item || item.submitting) return prev;
          if (item.secondsLeft <= 1) {
            clearTimer(tempId);
            void submitPending(tempId);
            return prev;
          }
          return prev.map((p) =>
            p.tempId === tempId ? { ...p, secondsLeft: p.secondsLeft - 1 } : p
          );
        });
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

  const isQueuedOrLibrary = useCallback(
    (entry: ChannelFeedEntry) => {
      if (entry.in_library) return true;
      if (queuedUrls.has(entry.url)) return true;
      if (pendingUrlsRef.current.has(entry.url)) return true;
      if (pending.some((p) => p.entry.url === entry.url)) return true;
      if (jobs.some((j) => j.url === entry.url && isActiveJob(j))) {
        return true;
      }
      return false;
    },
    [queuedUrls, pending, jobs]
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
    isQueuedOrLibrary,
    resolveVideoId,
    setLibraryVideoIds,
  };
}
