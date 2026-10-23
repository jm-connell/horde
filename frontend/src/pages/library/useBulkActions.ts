import { useEffect, useState } from "react";
import { api, downloadFileUrl, trashEntryIdsOfError } from "../../api";
import { describeError } from "../../apiErrors";
import { useToast } from "../../context/ToastContext";
import { offlineManager } from "../../offline/manager";
import { usePlaylists } from "../../queries/playlists";
import { deleteErrorMessage, useAfterDelete } from "../../queries/trash";
import { videoCount } from "../../trash";
import type { Video } from "../../types";

/**
 * What the bulk bar does with the selected videos. `videos` are the ones shown
 * (only those can be saved offline or as files); each action that finishes
 * leaves select mode.
 */
export function useBulkActions(input: {
  selectedIds: ReadonlySet<number>;
  videos: Video[];
  exitSelectMode: () => void;
  refreshLibrary: () => void;
}) {
  const { selectedIds, videos, exitSelectMode, refreshLibrary } = input;
  const { showToast, showError } = useToast();
  const [bulkNote, setBulkNote] = useState("");
  const [bulkNoteOpen, setBulkNoteOpen] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const playlistsQuery = usePlaylists(playlistOpen);
  const playlists = playlistsQuery.playlists;
  const playlistsFailed = playlistsQuery.isError;
  const [metadataSyncing, setMetadataSyncing] = useState(false);
  const afterDelete = useAfterDelete();

  useEffect(() => {
    if (playlistsFailed) showError("Could not load playlists");
  }, [playlistsFailed, showError]);

  const bulkDelete = async () => {
    if (!selectedIds.size) return;
    let trashed: number[];
    try {
      trashed = (await api.bulkDeleteVideos([...selectedIds], true))
        .trashEntryIds;
    } catch (err) {
      // Some may have moved before the failure: those can still be undone.
      const moved = trashEntryIdsOfError(err);
      if (moved.length) {
        afterDelete(moved, `Moved ${videoCount(moved.length)} to the trash`);
        refreshLibrary();
      }
      showError(deleteErrorMessage(err, "Could not delete selected videos"));
      throw err;
    }
    exitSelectMode();
    refreshLibrary();
    afterDelete(
      trashed,
      trashed.length
        ? `Moved ${videoCount(trashed.length)} to the trash`
        : `Deleted ${videoCount(selectedIds.size)}`
    );
  };

  const bulkSaveNote = async () => {
    if (!selectedIds.size || !bulkNote.trim()) return;
    try {
      await api.bulkUpdateNotes([...selectedIds], bulkNote.trim());
    } catch (err) {
      showError(`Could not save notes: ${describeError(err)}`);
      return;
    }
    setBulkNote("");
    setBulkNoteOpen(false);
    exitSelectMode();
  };

  const bulkAddToPlaylist = async (playlistId: number) => {
    if (!selectedIds.size) return;
    try {
      await api.bulkAddToPlaylist(playlistId, [...selectedIds]);
    } catch (err) {
      showError(`Could not add to playlist: ${describeError(err)}`);
      return;
    }
    setPlaylistOpen(false);
    exitSelectMode();
  };

  const bulkSaveFiles = () => {
    const selected = videos.filter((v) => selectedIds.has(v.id));
    selected.forEach((v, i) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = downloadFileUrl(v.id);
        a.download = v.title;
        a.click();
      }, i * 300);
    });
    exitSelectMode();
  };

  const bulkDownload = () => {
    // Plain-http access has no offline storage: save the files instead.
    if (offlineManager.getSnapshot().unsupported) {
      showToast("Saving files instead — offline downloads need HTTPS");
      bulkSaveFiles();
      return;
    }
    const selected = videos.filter((v) => selectedIds.has(v.id));
    selected.forEach((v) => void offlineManager.download(v));
    showToast(
      `Downloading ${selected.length} video${selected.length === 1 ? "" : "s"} for offline viewing`
    );
    exitSelectMode();
  };

  const bulkRefreshMetadata = async () => {
    if (!selectedIds.size || metadataSyncing) return;
    setMetadataSyncing(true);
    let result: Awaited<ReturnType<typeof api.refreshMetadataBulk>>;
    try {
      result = await api.refreshMetadataBulk([...selectedIds]);
    } catch (err) {
      showError(`Metadata sync failed: ${describeError(err)}`);
      return;
    } finally {
      setMetadataSyncing(false);
    }
    showToast(
      `Synced ${result.refreshed} video${result.refreshed === 1 ? "" : "s"}` +
        (result.failed ? ` (${result.failed} failed)` : "")
    );
    refreshLibrary();
    exitSelectMode();
  };

  return {
    selectedCount: selectedIds.size,
    playlists,
    playlistOpen,
    bulkNote,
    bulkNoteOpen,
    metadataSyncing,
    onTogglePlaylist: () => setPlaylistOpen(false),
    onOpenPlaylistPicker: () => setPlaylistOpen(true),
    onAddToPlaylist: bulkAddToPlaylist,
    onToggleNote: () => setBulkNoteOpen((v) => !v),
    onNoteChange: setBulkNote,
    onSaveNote: bulkSaveNote,
    onRefreshMetadata: bulkRefreshMetadata,
    onDownload: bulkDownload,
    onSaveFiles: bulkSaveFiles,
    onDelete: bulkDelete,
    onCancel: exitSelectMode,
  };
}
