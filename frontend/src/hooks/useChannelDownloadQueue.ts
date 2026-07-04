import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useDownloads } from "../context/DownloadContext";
import { PRESET_ORDER } from "../presets";
import type { ChannelFeedEntry, DownloadPreview } from "../types";

const CONFIRM_SECONDS = 5;

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

export function useChannelDownloadQueue(channelName: string) {
  const { submitDownload, onJobCompleted } = useDownloads();
  const [defaultPreset, setDefaultPreset] = useState("best");
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

  useEffect(() => {
    api.listPresets().then(setAllPresets).catch(() => undefined);
  }, []);

  useEffect(() => {
    return onJobCompleted((videoId) => {
      if (videoId == null) return;
      // Best-effort: refresh isn't required for optimistic UI.
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
      setPending((prev) => prev.filter((p) => p.tempId !== tempId));
    },
    [clearTimer]
  );

  const submitPending = useCallback(
    async (item: PendingChannelDownload) => {
      if (item.submitting) return;
      setPending((prev) =>
        prev.map((p) =>
          p.tempId === item.tempId ? { ...p, submitting: true } : p
        )
      );
      clearTimer(item.tempId);
      try {
        const detectedTitle = (item.entry.title ?? "").trim();
        const detectedChannel = channelName.trim();
        const title = item.title.trim();
        const channel = item.channel.trim();
        await submitDownload(item.entry.url, item.preset, {
          title: title && title !== detectedTitle ? title : undefined,
          channel: channel && channel !== detectedChannel ? channel : undefined,
          notes: item.notes.trim() || undefined,
        });
        setQueuedUrls((prev) => new Set(prev).add(item.entry.url));
        removePending(item.tempId);
      } catch {
        setPending((prev) =>
          prev.map((p) =>
            p.tempId === item.tempId ? { ...p, submitting: false } : p
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
            void submitPending(item);
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
      setPending((prev) => [...prev, item]);
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
                    preset:
                      p.preset === "best" && preview.available_presets.length > 0
                        ? preview.available_presets[0]
                        : p.preset,
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
    [channelName, defaultPreset, startCountdown]
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
      setPending((prev) => {
        const item = prev.find((p) => p.tempId === tempId);
        if (item) void submitPending(item);
        return prev;
      });
    },
    [submitPending]
  );

  const isQueuedOrLibrary = useCallback(
    (entry: ChannelFeedEntry) => {
      if (entry.in_library) return true;
      if (queuedUrls.has(entry.url)) return true;
      return false;
    },
    [queuedUrls]
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
