import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, thumbnailUrl } from "../api";
import AddToPlaylist from "../components/AddToPlaylist";
import LinkifiedText from "../components/LinkifiedText";
import VideoActionsMenu from "../components/VideoActionsMenu";
import VideoEditForm from "../components/VideoEditForm";
import { useDownloads } from "../context/DownloadContext";
import { usePlayback } from "../context/PlaybackContext";
import { useToast } from "../context/ToastContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSettings } from "../hooks/useSettings";
import type { Video } from "../types";
import { formatDate, formatResolution, formatSize } from "../utils";

const PRESET_LABELS: Record<string, string> = {
  best: "Best available",
  "1440p": "1440p (2K)",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
  audio: "Audio only",
};

export default function Watch() {
  const { id } = useParams();
  const navigate = useNavigate();
  const videoId = Number(id);
  const [video, setVideo] = useState<Video | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editFocus, setEditFocus] = useState<"notes" | undefined>(undefined);
  const [descExpanded, setDescExpanded] = useState(false);
  const [redownloadOpen, setRedownloadOpen] = useState(false);
  const [redownloadPreset, setRedownloadPreset] = useState("1080p");
  const [presets, setPresets] = useState<string[]>(["best"]);
  const [redownloading, setRedownloading] = useState(false);
  const [settings] = useSettings();
  const { showToast } = useToast();
  const { onJobCompleted, refreshJobs } = useDownloads();
  const redownloadPending = useRef(false);
  const isMobile = useIsMobile();
  const {
    mode,
    playVideo,
    registerDock,
    queue,
    removeFromQueue,
    reorderQueue,
    clearQueue,
  } = usePlayback();

  const dockRef = useRef<HTMLDivElement>(null);
  const dragIndex = useRef<number | null>(null);

  useEffect(() => {
    if (!videoId) return;
    api
      .getVideo(videoId)
      .then((v) => {
        setVideo(v);
        playVideo(v);
      })
      .catch(() => setError("Video not found"));
  }, [videoId, playVideo]);

  useEffect(() => {
    registerDock(dockRef.current);
    return () => registerDock(null);
  }, [registerDock, video, mode]);

  useEffect(() => {
    api.listPresets().then(setPresets).catch(() => undefined);
  }, []);

  useEffect(() => {
    return onJobCompleted((completedId, event) => {
      if (!redownloadPending.current || completedId !== videoId) return;
      redownloadPending.current = false;
      api.getVideo(videoId).then(setVideo).catch(() => undefined);
      if (event?.quality_warning) {
        showToast(event.quality_warning);
      } else {
        showToast("Redownload complete.");
      }
    });
  }, [onJobCompleted, videoId, showToast]);

  const onRedownload = async () => {
    setRedownloading(true);
    try {
      redownloadPending.current = true;
      await api.redownloadVideo(
        videoId,
        redownloadPreset,
        settings.normalizeVolumeOnDownload
      );
      showToast("Download started — check the Download page for progress.");
      refreshJobs();
      setRedownloadOpen(false);
    } catch (err) {
      redownloadPending.current = false;
      showToast(
        err instanceof Error ? err.message : "Could not start download"
      );
    } finally {
      setRedownloading(false);
    }
  };

  const onDelete = async () => {
    if (!video) return;
    if (!confirm(`Delete "${video.title}" from the library?`)) return;
    await api.deleteVideo(video.id);
    navigate("/");
  };

  if (error) {
    return <p className="py-20 text-center text-gray-500">{error}</p>;
  }
  if (!video) {
    return <p className="py-20 text-center text-gray-500">Loading...</p>;
  }

  const isWide = !isMobile && mode === "theater";
  const resolution = formatResolution(video.height_px);
  // Theater: full-bleed black bar, player at least as wide as standard (max-w-5xl).
  const theaterWidthClass =
    "mx-auto w-[clamp(min(100%,64rem),85vw,100vw)]";
  const contentClass = isWide ? theaterWidthClass : "mx-auto max-w-5xl";

  const playerOuterClass = isMobile
    ? "bg-black"
    : isWide
      ? "relative left-1/2 w-screen -translate-x-1/2 bg-black"
      : "mx-auto max-w-5xl";
  const playerInnerClass = isWide && !isMobile ? theaterWidthClass : "w-full";

  return (
    <div>
      <div className={playerOuterClass}>
        <div className={playerInnerClass}>
          <div ref={dockRef} className="w-full" />
        </div>
      </div>

      <div className={contentClass}>
        <div className="mt-5">
          <h1 className="text-xl font-bold text-gray-100">{video.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-400">
            {video.channel && (
              <Link
                to={`/?channel=${encodeURIComponent(video.channel)}`}
                className="font-medium text-accent hover:underline"
              >
                {video.channel}
              </Link>
            )}
            {video.published_at && <span>{formatDate(video.published_at)}</span>}
            <span>{formatSize(video.file_size)}</span>
            {resolution && (
              <span className="text-xs text-gray-500">{resolution}</span>
            )}
          </div>

          {settings.showDescription && (video.description || video.notes) && (
            <div className="mt-4 rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700">
              {video.description && (
                <>
                  <p
                    className={`whitespace-pre-wrap text-sm text-gray-300 ${
                      descExpanded ? "" : "line-clamp-3"
                    }`}
                  >
                    <LinkifiedText text={video.description} />
                  </p>
                  <button
                    onClick={() => setDescExpanded((v) => !v)}
                    className="mt-2 text-xs font-medium text-accent hover:underline"
                  >
                    {descExpanded ? "Show less" : "Show more"}
                  </button>
                </>
              )}

              {video.notes &&
                (descExpanded || !video.description) && (
                  <div
                    className={
                      video.description
                        ? "mt-4 border-t border-ink-700 pt-4"
                        : ""
                    }
                  >
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent">
                      Your notes
                    </h3>
                    <p className="whitespace-pre-wrap text-sm text-gray-300">
                      <LinkifiedText text={video.notes} />
                    </p>
                  </div>
                )}
            </div>
          )}

          {!settings.showDescription && video.notes && (
            <div className="mt-4 rounded-xl border border-accent/30 bg-accent/5 p-4">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent">
                Your notes
              </h3>
              <p className="whitespace-pre-wrap text-sm text-gray-300">
                <LinkifiedText text={video.notes} />
              </p>
            </div>
          )}

          {queue.length > 0 && (
            <div className="mt-4 rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Up next ({queue.length})
                </h3>
                <button
                  onClick={clearQueue}
                  className="text-xs text-gray-500 hover:text-accent"
                >
                  Clear
                </button>
              </div>
              <ul className="space-y-1">
                {queue.map((v, index) => {
                  const thumb = thumbnailUrl(v);
                  return (
                    <li
                      key={v.id}
                      draggable
                      onDragStart={() => (dragIndex.current = index)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (dragIndex.current !== null) {
                          reorderQueue(dragIndex.current, index);
                        }
                        dragIndex.current = null;
                      }}
                      onDragEnd={() => (dragIndex.current = null)}
                      className="flex items-center gap-2 rounded-lg p-1 hover:bg-ink-800"
                    >
                      <span
                        className="shrink-0 cursor-grab px-1 text-gray-600 active:cursor-grabbing"
                        title="Drag to reorder"
                      >
                        ⠿
                      </span>
                      <button
                        onClick={() => playVideo(v)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-ink-800">
                          {thumb && (
                            <img
                              src={thumb}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          )}
                        </div>
                        <span className="min-w-0 flex-1 truncate text-sm text-gray-200">
                          {v.title}
                        </span>
                      </button>
                      <button
                        onClick={() => removeFromQueue(v.id)}
                        className="shrink-0 px-2 text-gray-500 hover:text-accent"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {editing && (
            <div className="mt-4">
              <VideoEditForm
                video={video}
                saveLabel="Save changes"
                focusField={editFocus}
                onCancel={() => {
                  setEditing(false);
                  setEditFocus(undefined);
                }}
                onSaved={(updated) => {
                  setVideo(updated);
                  setEditing(false);
                  setEditFocus(undefined);
                }}
              />
            </div>
          )}

          <div className="mt-5 flex gap-2">
            <Link
              to="/"
              className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
            >
              ← Back to library
            </Link>
            <AddToPlaylist videoId={video.id} />
            <VideoActionsMenu
              video={video}
              onEdit={() => {
                setEditFocus(undefined);
                setEditing((v) => !v);
              }}
              onAddNote={() => {
                setEditFocus("notes");
                setEditing(true);
              }}
              onChangeResolution={() => setRedownloadOpen(true)}
              onDelete={onDelete}
            />
          </div>
        </div>
      </div>

      {redownloadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700">
            <h2 className="mb-1 text-lg font-semibold text-gray-100">
              Change resolution
            </h2>
            <p className="mb-4 text-sm text-gray-400">
              This replaces the video file on disk with a newly downloaded copy at
              the selected resolution. Your title, notes, and other metadata are
              kept. Playback may be unavailable until the download finishes.
            </p>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Quality
            </label>
            <select
              value={redownloadPreset}
              onChange={(e) => setRedownloadPreset(e.target.value)}
              className="mb-6 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-gray-100 outline-none focus:border-accent"
            >
              {presets.map((p) => (
                <option key={p} value={p}>
                  {PRESET_LABELS[p] ?? p}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRedownloadOpen(false)}
                className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
              >
                Cancel
              </button>
              <button
                onClick={onRedownload}
                disabled={redownloading}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:opacity-50"
              >
                {redownloading ? "Starting…" : "Replace file"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
