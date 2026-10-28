import { Link } from "react-router-dom";
import AddToPlaylist from "../../components/AddToPlaylist";
import OfflineDownloadButton from "../../components/OfflineDownloadButton";
import VideoActionsMenu from "../../components/VideoActionsMenu";
import VideoEditForm from "../../components/VideoEditForm";
import { useAuth } from "../../context/AuthContext";
import type { Video } from "../../types";
import type { WatchActionsState } from "./useWatchActions";

/** The edit form and the action row (back, playlist, offline, ••• menu) under a library video. */
export default function WatchActions({
  video,
  actions,
  isMobile,
  onVideoUpdated,
  onSaveClip,
}: {
  video: Video;
  actions: WatchActionsState;
  isMobile: boolean;
  onVideoUpdated: (video: Video) => void;
  /** Open the clip picker (a downloaded YouTube video). */
  onSaveClip?: () => void;
}) {
  const { can } = useAuth();
  return (
    <>
      {actions.editing && (
        <div className="mt-4">
          <VideoEditForm
            video={video}
            saveLabel="Save changes"
            focusField={actions.editFocus}
            onCancel={() => {
              actions.setEditing(false);
              actions.setEditFocus(undefined);
            }}
            onSaved={(updated) => {
              onVideoUpdated(updated);
              actions.setEditing(false);
              actions.setEditFocus(undefined);
            }}
          />
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2 whitespace-nowrap">
        <Link
          to="/"
          aria-label={isMobile ? "Back to library" : undefined}
          className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700"
        >
          {/* Phones: icon only, so the Download button fits the row. */}
          {isMobile ? "←" : "← Back to library"}
        </Link>
        {video.id > 0 && <AddToPlaylist videoId={video.id} />}
        {/* Phones get a dedicated button; desktop uses the ••• menu. */}
        {isMobile && can("offline_download") && (
          <OfflineDownloadButton video={video} />
        )}
        {video.id > 0 && (
          <VideoActionsMenu
            video={video}
            onEdit={() => {
              actions.setEditFocus(undefined);
              actions.setEditing((v) => !v);
            }}
            onAddNote={() => {
              actions.setEditFocus("notes");
              actions.setEditing(true);
            }}
            onChangeResolution={() => actions.setRedownloadOpen(true)}
            onNormalizeVolume={actions.onNormalizeVolume}
            onDelete={actions.onDelete}
            onVideoUpdated={onVideoUpdated}
            onSaveClip={onSaveClip}
          />
        )}
      </div>
    </>
  );
}
