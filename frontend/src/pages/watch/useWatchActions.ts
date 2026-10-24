import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { describeError } from "../../apiErrors";
import { usePresets } from "../../queries/app";
import {
  deleteErrorMessage,
  useAfterDelete,
  useTrashRetentionDays,
} from "../../queries/trash";
import { videoDetailQuery } from "../../queries/videos";
import { deleteConfirmCopy } from "../../trash";
import { useConfirm } from "../../context/ConfirmContext";
import { useDownloads } from "../../context/DownloadContext";
import { usePlaybackActions } from "../../context/PlaybackContext";
import { useToast } from "../../context/ToastContext";
import { useSettings } from "../../hooks/useSettings";
import type { Video } from "../../types";
import type { WatchSource } from "./useWatchVideo";

/**
 * What can be done to the library video on screen: edit, change its
 * resolution (redownload), normalize its volume and delete it. The redownload
 * handoff to the new file also lives here.
 */
export function useWatchActions({
  video,
  setSource,
}: {
  video: Video | null;
  setSource: (source: WatchSource | null) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { showToast, showError } = useToast();
  const { onJobCompleted, refreshJobs } = useDownloads();
  const { playVideo, getCurrentPosition } = usePlaybackActions();
  const presets = usePresets();
  const [settings] = useSettings();
  const retentionDays = useTrashRetentionDays();
  const afterDelete = useAfterDelete();
  const [editing, setEditing] = useState(false);
  const [editFocus, setEditFocus] = useState<"notes" | undefined>(undefined);
  const [redownloadOpen, setRedownloadOpen] = useState(false);
  const [redownloadPreset, setRedownloadPreset] = useState("1080p");
  const redownloadPending = useRef(false);

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
          const updated = await queryClient.fetchQuery({
            ...videoDetailQuery(video.id),
            staleTime: 0,
          });
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
          queryClient
            .fetchQuery({ ...videoDetailQuery(video.id), staleTime: 0 })
            .then((v) => setSource({ kind: "library", video: v }))
            .catch(() => undefined);
          showToast(event?.quality_warning || "Redownload complete.");
        }
      })();
    });
  }, [
    onJobCompleted,
    video,
    setSource,
    showToast,
    getCurrentPosition,
    playVideo,
    queryClient,
  ]);

  const redownloadMutation = useMutation({
    mutationFn: (v: {
      id: number;
      preset: string;
      normalize: boolean;
      message: string;
      closeDialog: boolean;
    }) =>
      api.redownloadVideo(
        v.id,
        v.preset,
        v.normalize,
        settings.downloadVideoCodec
      ),
    onMutate: () => {
      redownloadPending.current = true;
    },
    onSuccess: (_video, v) => {
      showToast(v.message);
      refreshJobs();
      if (v.closeDialog) setRedownloadOpen(false);
    },
    onError: (err) => {
      redownloadPending.current = false;
      showError(describeError(err) || "Could not start download");
    },
  });
  const redownloading = redownloadMutation.isPending;

  const deleteMutation = useMutation({
    mutationFn: (v: { id: number; title: string }) =>
      api.deleteVideo(v.id, true),
    onSuccess: (result, v) => {
      afterDelete(
        result.trashEntryIds,
        result.trashEntryIds.length
          ? `Moved “${v.title}” to the trash`
          : `Deleted “${v.title}”`
      );
      navigate("/");
    },
    onError: (err) => showError(deleteErrorMessage(err)),
  });

  const onRedownload = () => {
    if (!video) return;
    redownloadMutation.mutate({
      id: video.id,
      preset: redownloadPreset,
      normalize: settings.normalizeVolumeOnDownload,
      message: "Download started — check the Download page for progress.",
      closeDialog: true,
    });
  };

  const onNormalizeVolume = () => {
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
      preset = presets.includes("1080p") ? "1080p" : (presets[0] ?? "best");
    }
    redownloadMutation.mutate({
      id: video.id,
      preset,
      normalize: true,
      message:
        "Normalizing via redownload — check the Download page for progress.",
      closeDialog: false,
    });
  };

  const onDelete = async () => {
    if (!video) return;
    const copy = deleteConfirmCopy(retentionDays, {
      count: 1,
      title: video.title,
    });
    const ok = await confirm({
      title: copy.title,
      body: copy.body,
      confirmLabel: copy.confirmLabel,
      danger: true,
    });
    if (!ok) return;
    deleteMutation.mutate({ id: video.id, title: video.title });
  };

  return {
    editing,
    setEditing,
    editFocus,
    setEditFocus,
    redownloadOpen,
    setRedownloadOpen,
    redownloadPreset,
    setRedownloadPreset,
    presets,
    redownloading,
    onRedownload,
    onNormalizeVolume,
    onDelete,
  };
}

export type WatchActionsState = ReturnType<typeof useWatchActions>;
