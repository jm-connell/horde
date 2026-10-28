import { useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useTrashRetentionDays } from "../queries/trash";
import { deleteConfirmCopy } from "../trash";
import ConfirmDialog from "./ConfirmDialog";
import { MenuFlyout, MenuScroll } from "./MenuFlyout";
import type { Playlist } from "../types";
import { focusOnMount } from "../utils";
import { button } from "./buttons";

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
  onSaveFiles,
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
  onSaveFiles: () => void;
  onDelete: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const { can, isAdmin } = useAuth();
  const playlistTriggerRef = useRef<HTMLButtonElement>(null);
  const noteTriggerRef = useRef<HTMLButtonElement>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteCopy = deleteConfirmCopy(useTrashRetentionDays(), {
    count: selectedCount,
  });

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

          {/* Everyone can keep private playlists; only editable ones are offered. */}
          <div className="relative">
            <button
              ref={playlistTriggerRef}
              onClick={() =>
                playlistOpen ? onTogglePlaylist() : onOpenPlaylistPicker()
              }
              aria-haspopup="menu"
              aria-expanded={playlistOpen}
              className={button("secondary", "sm")}
            >
              + Playlist
            </button>
            <MenuFlyout
              open={playlistOpen}
              className="absolute bottom-10 left-0 z-50 w-56"
              menu={{
                label: "Add to playlist",
                onClose: onTogglePlaylist,
                triggerRef: playlistTriggerRef,
              }}
            >
              <MenuScroll className="max-h-56" revision={playlists.length}>
                {playlists.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-muted">
                    No playlists yet.
                  </p>
                ) : (
                  playlists.map((p) => (
                    <button
                      key={p.id}
                      role="menuitem"
                      onClick={() => onAddToPlaylist(p.id)}
                      className="block w-full truncate px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-ink-700"
                    >
                      {p.name}
                    </button>
                  ))
                )}
              </MenuScroll>
            </MenuFlyout>
          </div>

          {can("edit_metadata") && (
            <div className="relative">
              <button
                ref={noteTriggerRef}
                onClick={onToggleNote}
                aria-haspopup="dialog"
                aria-expanded={bulkNoteOpen}
                className={button("secondary", "sm")}
              >
                Add note
              </button>
              <MenuFlyout
                open={bulkNoteOpen}
                className="absolute bottom-10 left-0 z-50 w-72"
                menu={{
                  kind: "popup",
                  label: "Note for selected videos",
                  onClose: onToggleNote,
                  triggerRef: noteTriggerRef,
                }}
              >
                <div className="p-3">
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted">
                      Note
                    </span>
                  </div>
                  <textarea
                    value={bulkNote}
                    onChange={(e) => onNoteChange(e.target.value)}
                    rows={3}
                    placeholder="Note to apply to all selected…"
                    className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-hidden focus:border-accent"
                    ref={focusOnMount}
                  />
                  <button
                    onClick={onSaveNote}
                    disabled={!bulkNote.trim()}
                    className={`${button("primary", "sm")} mt-2 w-full`}
                  >
                    Apply to {selectedCount} video
                    {selectedCount === 1 ? "" : "s"}
                  </button>
                </div>
              </MenuFlyout>
            </div>
          )}

          {/* The bulk metadata refresh is admin-only on the server. */}
          {isAdmin && (
            <button
              onClick={onRefreshMetadata}
              disabled={metadataSyncing}
              className={button("secondary", "sm")}
            >
              {metadataSyncing ? "Syncing…" : "Resync metadata"}
            </button>
          )}

          {can("offline_download") && (
            <button onClick={onDownload} className={button("secondary", "sm")}>
              Download
            </button>
          )}

          {can("offline_download") && (
            <button
              onClick={onSaveFiles}
              title="Save the video files to your device’s downloads folder"
              className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-400 hover:border-accent hover:text-gray-200"
            >
              Save files
            </button>
          )}

          {can("delete_videos") && (
            <button
              type="button"
              onClick={() => setDeleteConfirmOpen(true)}
              className={button("danger", "sm")}
            >
              Delete
            </button>
          )}

          <button
            type="button"
            onClick={onCancel}
            className="ml-auto text-xs text-muted hover:text-accent"
          >
            Cancel
          </button>
        </div>
      </div>
      {deleteConfirmOpen ? (
        <ConfirmDialog
          title={deleteCopy.title}
          body={deleteCopy.body}
          confirmLabel={deleteCopy.confirmLabel}
          danger
          busy={deleting}
          busyLabel={deleteCopy.busyLabel}
          onCancel={closeDeleteConfirm}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  );
}
