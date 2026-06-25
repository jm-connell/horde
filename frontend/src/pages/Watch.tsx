import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, thumbnailUrl } from "../api";
import AddToPlaylist from "../components/AddToPlaylist";
import LinkifiedText from "../components/LinkifiedText";
import VideoEditForm from "../components/VideoEditForm";
import { usePlayback } from "../context/PlaybackContext";
import { useSettings } from "../hooks/useSettings";
import type { Video } from "../types";
import { formatDate, formatDuration, formatSize } from "../utils";

export default function Watch() {
  const { id } = useParams();
  const navigate = useNavigate();
  const videoId = Number(id);
  const [video, setVideo] = useState<Video | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [settings] = useSettings();
  const { mode, playVideo, registerDock, queue, removeFromQueue, clearQueue } =
    usePlayback();

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
    registerDock(dockRef.current);
    return () => registerDock(null);
  }, [registerDock, video]);

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

  const isWide = mode === "theater";

  return (
    <div className={isWide ? "-mx-6" : "mx-auto max-w-4xl"}>
      <div className={isWide ? "bg-black" : ""}>
        <div className={isWide ? "mx-auto max-w-[1400px]" : ""}>
          <div ref={dockRef} />
        </div>
      </div>

      <div className={isWide ? "mx-auto max-w-4xl px-6" : ""}>
        <div className="mt-5">
          <h1 className="text-xl font-bold text-gray-100">{video.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-400">
            {video.channel && (
              <span className="flex items-center gap-1.5">
                <Link
                  to={`/?channel=${encodeURIComponent(video.channel)}`}
                  className="font-medium text-accent hover:underline"
                >
                  {video.channel}
                </Link>
                {video.channel_url && (
                  <a
                    href={video.channel_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-gray-500 hover:text-accent"
                    title="Open channel page"
                  >
                    ↗
                  </a>
                )}
              </span>
            )}
            {video.published_at && <span>{formatDate(video.published_at)}</span>}
            <span>{formatDuration(video.duration_sec)}</span>
            <span>{formatSize(video.file_size)}</span>
            {video.platform && <span>{video.platform}</span>}
          </div>

          {video.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {video.tags.map((tag) => (
                <Link
                  key={tag}
                  to={`/?tag=${encodeURIComponent(tag)}`}
                  className="rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-accent-soft hover:border-accent"
                >
                  #{tag}
                </Link>
              ))}
            </div>
          )}

          {video.source_url && (
            <a
              href={video.source_url}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-sm text-accent hover:underline"
            >
              Source link ↗
            </a>
          )}

          {settings.showDescription && video.description && (
            <div className="mt-4 rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700">
              <p className="whitespace-pre-wrap text-sm text-gray-300">
                <LinkifiedText text={video.description} />
              </p>
            </div>
          )}

          {video.notes && (
            <div className="mt-4 rounded-xl border border-accent/30 bg-accent/5 p-4">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent">
                Notes
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
                {queue.map((v) => {
                  const thumb = thumbnailUrl(v);
                  return (
                    <li
                      key={v.id}
                      className="flex items-center gap-3 rounded-lg p-1 hover:bg-ink-800"
                    >
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
                onCancel={() => setEditing(false)}
                onSaved={(updated) => {
                  setVideo(updated);
                  setEditing(false);
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
            <button
              onClick={() => setEditing((v) => !v)}
              className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
            >
              {editing ? "Close editor" : "Edit"}
            </button>
            <AddToPlaylist videoId={video.id} />
            <button
              onClick={onDelete}
              className="rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
