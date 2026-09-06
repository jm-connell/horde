import { useEffect, useState } from "react";
import type { Playlist } from "../types";

export default function LibraryBulkBar({
  selectedCount,
  playlists,
  playlistOpen,
  bulkNote,
  bulkNoteOpen,
  metadataSyncing,
  onTogglePlaylist,
  onOpenPlaylistPicker,
  onAddToPlaylist,
  onToggleNote,
  onNoteChange,
  onSaveNote,
  onRefreshMetadata,
  onDownload,
  onDelete,
  onCancel,
}: {
  selectedCount: number;
  playlists: Playlist[];
  playlistOpen: boolean;
  bulkNote: string;
  bulkNoteOpen: boolean;
  metadataSyncing: boolean;
  onTogglePlaylist: () => void;
  onOpenPlaylistPicker: () => void;
  onAddToPlaylist: (playlistId: number) => void;
  onToggleNote: () => void;
  onNoteChange: (value: string) => void;
  onSaveNote: () => void;
  onRefreshMetadata: () => void;
  onDownload: () => void;
  onDelete: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const videoWord = selectedCount === 1 ? "video" : "videos";
  const deleteBody =
    selectedCount === 1
      ? "This video will be removed from your library and the file will be permanently deleted."
      : "These videos will be removed from your library and the files will be permanently deleted.";

  useEffect(() => {
    if (!deleteConfirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) setDeleteConfirmOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteConfirmOpen, deleting]);

  const closeDeleteConfirm = () => {
    if (deleting) return;
    setDeleteConfirmOpen(false);
  };

  const confirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await onDelete();
      setDeleteConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="ui-panel ui-panel-legible fixed inset-x-0 bottom-0 z-40 border border-ink-700 px-4 py-3">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-gray-300">
            {selectedCount} selected
          </span>

          <div className="relative">
            <button
              onClick={() =>
                playlistOpen ? onTogglePlaylist() : onOpenPlaylistPicker()
              }
              className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-200 hover:border-accent"
            >
              + Playlist
            </button>
            {playlistOpen && (
              <div className="absolute bottom-10 left-0 z-50 w-56 rounded-lg bg-ink-800 p-2 shadow-xl ring-1 ring-ink-600">
                {playlists.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-gray-500">No playlists yet.</p>
                ) : (
                  playlists.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => onAddToPlaylist(p.id)}
                      className="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-gray-200 hover:bg-ink-700"
                    >
                      {p.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              onClick={onToggleNote}
              className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-200 hover:border-accent"
            >
              Add note
            </button>
            {bulkNoteOpen && (
              <div className="absolute bottom-10 left-0 z-50 w-72 rounded-lg bg-ink-800 p-3 shadow-xl ring-1 ring-ink-600">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
                    Note
                  </span>
                </div>
                <textarea
                  value={bulkNote}
                  onChange={(e) => onNoteChange(e.target.value)}
                  rows={3}
                  placeholder="Note to apply to all selected..."
                  className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
                  autoFocus
                />
                <button
                  onClick={onSaveNote}
                  disabled={!bulkNote.trim()}
                  className="mt-2 w-full rounded-lg bg-accent py-1.5 text-sm font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-40"
                >
                  Apply to {selectedCount} video{selectedCount === 1 ? "" : "s"}
                </button>
              </div>
            )}
          </div>

          <button
            onClick={onRefreshMetadata}
            disabled={metadataSyncing}
            className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-200 hover:border-accent disabled:opacity-50"
          >
            {metadataSyncing ? "Syncing…" : "Resync metadata"}
          </button>

          <button
            onClick={onDownload}
            className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-200 hover:border-accent"
          >
            Download
          </button>

          <button
            type="button"
            onClick={() => setDeleteConfirmOpen(true)}
            className="ui-panel ui-interactive rounded-lg border border-red-500/40 bg-ink-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10"
          >
            Delete
          </button>

          <button
            type="button"
            onClick={onCancel}
            className="ml-auto text-xs text-gray-500 hover:text-accent"
          >
            Cancel
          </button>
        </div>
      </div>
      {deleteConfirmOpen ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={closeDeleteConfirm}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-delete-title"
            className="ui-panel w-full max-w-sm rounded-xl bg-ink-900 p-5 shadow-xl ring-1 ring-ink-600"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="bulk-delete-title"
              className="text-base font-semibold text-gray-100"
            >
              Delete {selectedCount} {videoWord}?
            </h2>
            <p className="mt-2 text-sm text-gray-300">{deleteBody}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeDeleteConfirm}
                disabled={deleting}
                className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-300 hover:bg-ink-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
