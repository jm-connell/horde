import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, thumbnailUrl } from "../api";
import AddToPlaylist from "../components/AddToPlaylist";
import ChaptersList from "../components/ChaptersList";
import LinkifiedText from "../components/LinkifiedText";
import PlaybackQueue from "../components/PlaybackQueue";
import VideoActionsMenu from "../components/VideoActionsMenu";
import VideoEditForm from "../components/VideoEditForm";
import { useDownloads } from "../context/DownloadContext";
import { usePlayback } from "../context/PlaybackContext";
import { useToast } from "../context/ToastContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSettings } from "../hooks/useSettings";
import type { Video } from "../types";
import { formatDate, formatDuration, formatResolution, formatSize, parseChapters } from "../utils";

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
  const [moreLikeThis, setMoreLikeThis] = useState<Video[]>([]);
  const [redownloadOpen, setRedownloadOpen] = useState(false);
  const [redownloadPreset, setRedownloadPreset] = useState("1080p");
  const [presets, setPresets] = useState<string[]>(["best"]);
  const [redownloading, setRedownloading] = useState(false);
  const [settings, updateSettings] = useSettings();
  const { showToast } = useToast();
  const { onJobCompleted, refreshJobs } = useDownloads();
  const redownloadPending = useRef(false);
  const isMobile = useIsMobile();
  const {
    mode,
    playVideo,
    registerDock,
    queue,
  } = usePlayback();

  const dockRef = useRef<HTMLDivElement>(null);

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
    if (!video) return;
    api
      .getRelatedVideos(video.id, 6)
      .then(setMoreLikeThis)
      .catch(() => setMoreLikeThis([]));
  }, [video?.id]);

  useEffect(() => {
    if (!video?.subtitles_pending) return;
    const timer = window.setInterval(() => {
      api.getVideo(videoId).then(setVideo).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [videoId, video?.subtitles_pending]);

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
    await api.deleteVideo(video.id, true);
    navigate("/");
  };

  if (error) {
    return <p className="py-20 text-center text-gray-500">{error}</p>;
  }
  if (!video) {
    return <p className="py-20 text-center text-gray-500">Loading...</p>;
  }

  const isWide = !isMobile && mode === "theater";
  const showRelatedRight =
    !isMobile &&
    mode === "standard" &&
    settings.showRelatedVideos &&
    moreLikeThis.length > 0;
  const resolution = formatResolution(video.height_px);
  const contentClass = showRelatedRight
    ? "mx-auto max-w-[90rem]"
    : "mx-auto max-w-5xl xl:max-w-6xl 2xl:max-w-7xl";

  const playerOuterClass = isMobile
    ? "relative left-1/2 w-screen -translate-x-1/2 bg-black"
    : isWide
      ? "relative left-1/2 w-screen -translate-x-1/2 bg-black"
      : showRelatedRight
        ? "w-full bg-black"
        : "mx-auto max-w-5xl";
  const playerInnerClass = isWide && !isMobile ? "mx-auto w-full" : "w-full";

  const relatedList = (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        More like this
      </h3>
      <div className="space-y-2">
        {moreLikeThis.map((v) => {
          const thumb = thumbnailUrl(v);
          return (
            <Link
              key={v.id}
              to={`/watch/${v.id}`}
              className="group flex gap-2 rounded-lg p-1 transition-colors hover:bg-ink-800"
            >
              <div className="aspect-video w-40 shrink-0 overflow-hidden rounded-lg bg-ink-800">
                {thumb ? (
                  <img
                    src={thumb}
                    alt={v.title}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-ink-600">
                    <span className="text-xl">▶</span>
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 py-0.5">
                <p className="line-clamp-2 text-sm font-medium text-gray-200 group-hover:text-accent">
                  {v.title}
                </p>
                {v.channel && (
                  <p className="mt-0.5 truncate text-xs text-gray-500">
                    {v.channel}
                  </p>
                )}
                {v.duration_sec != null && (
                  <p className="mt-0.5 text-xs text-gray-600">
                    {formatDuration(v.duration_sec)}
                  </p>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className={contentClass}>
      <div
        className={
          showRelatedRight
            ? "grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]"
            : undefined
        }
      >
        <div className="min-w-0">
          <div className={playerOuterClass}>
            <div className={playerInnerClass}>
              <div ref={dockRef} className="w-full" />
            </div>
          </div>

          <div>
        {/* Metadata change banner */}
        {video.title_is_custom &&
          video.source_title &&
          video.source_title !== video.title && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink-800 px-4 py-3 ring-1 ring-ink-600">
              <p className="text-sm text-gray-300">
                Source title changed:{" "}
                <span className="text-gray-400 line-through">{video.title}</span>{" "}
                →{" "}
                <span className="text-gray-200">{video.source_title}</span>
              </p>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    const updated = await api
                      .updateVideo(video!.id, { title: video!.source_title! })
                      .catch(() => null);
                    if (updated) setVideo(updated);
                  }}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink-950 hover:bg-accent-soft"
                >
                  Use source
                </button>
                <button
                  onClick={async () => {
                    const updated = await api
                      .updateVideo(video!.id, { title: video!.title })
                      .catch(() => null);
                    if (updated) setVideo(updated);
                  }}
                  className="rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-ink-600"
                >
                  Keep mine
                </button>
              </div>
            </div>
          )}
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
            {video.frame_rate && video.frame_rate > 60 && (
              <span className="text-xs text-gray-500">
                {Math.round(video.frame_rate)}fps
              </span>
            )}
          </div>

          <div
            className={
              !showRelatedRight && queue.length > 0
                ? "mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]"
                : "mt-4 space-y-4"
            }
          >
            <div className="min-w-0 space-y-4">
              <ChaptersList chapters={parseChapters(video.description)} />

              {settings.showDescription && (video.description || video.notes) && (
                <div className="rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700">
                  <button
                    type="button"
                    onClick={() =>
                      updateSettings({
                        descriptionExpanded: !settings.descriptionExpanded,
                      })
                    }
                    className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-accent"
                  >
                    <span>Description</span>
                    <span>{settings.descriptionExpanded ? "▲" : "▼"}</span>
                  </button>

                  {settings.descriptionExpanded && (
                    <>
                      {video.description && (
                        <>
                          <p
                            className={`mt-3 whitespace-pre-wrap text-sm text-gray-300 ${
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
                                : "mt-3"
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
                    </>
                  )}
                </div>
              )}

              {!settings.showDescription && video.notes && (
                <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent">
                    Your notes
                  </h3>
                  <p className="whitespace-pre-wrap text-sm text-gray-300">
                    <LinkifiedText text={video.notes} />
                  </p>
                </div>
              )}
            </div>

            {!showRelatedRight && queue.length > 0 && (
              <PlaybackQueue className="lg:sticky lg:top-20 lg:self-start" />
            )}
          </div>

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

          {/* More like this — bottom grid when sidebar is off */}
          {!showRelatedRight && moreLikeThis.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                More like this
              </h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {moreLikeThis.map((v) => {
                  const thumb = thumbnailUrl(v);
                  return (
                    <Link
                      key={v.id}
                      to={`/watch/${v.id}`}
                      className="ui-card group flex flex-col overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700 transition-all hover:ring-accent/60"
                    >
                      <div className="aspect-video w-full overflow-hidden bg-ink-800">
                        {thumb ? (
                          <img
                            src={thumb}
                            alt={v.title}
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-ink-600">
                            <span className="text-3xl">▶</span>
                          </div>
                        )}
                      </div>
                      <div className="p-2">
                        <p className="line-clamp-2 text-xs font-medium text-gray-200 group-hover:text-accent">
                          {v.title}
                        </p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>
          </div>
        </div>

        {showRelatedRight && (
          <aside className="hidden space-y-6 xl:block">
            {queue.length > 0 && (
              <PlaybackQueue className="sticky top-20" />
            )}
            <div className={queue.length > 0 ? "" : "sticky top-20"}>
              {relatedList}
            </div>
          </aside>
        )}
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
