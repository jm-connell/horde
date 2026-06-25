import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, streamUrl } from "../api";
import VideoPlayer, { type ViewMode } from "../components/VideoPlayer";
import type { Video } from "../types";
import { formatDate, formatDuration, formatSize } from "../utils";

export default function Watch() {
  const { id } = useParams();
  const navigate = useNavigate();
  const videoId = Number(id);
  const [video, setVideo] = useState<Video | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("standard");

  useEffect(() => {
    if (!videoId) return;
    api
      .getVideo(videoId)
      .then(setVideo)
      .catch(() => setError("Video not found"));
  }, [videoId]);

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
          <VideoPlayer src={streamUrl(video.id)} mode={mode} onModeChange={setMode} />
        </div>
      </div>

      <div className={isWide ? "mx-auto max-w-4xl px-6" : ""}>
        <div className="mt-5">
          <h1 className="text-xl font-bold text-gray-100">{video.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-400">
            {video.channel && (
              <span className="font-medium text-accent">{video.channel}</span>
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

          {video.description && (
            <div className="mt-4 rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700">
              <p className="whitespace-pre-wrap text-sm text-gray-300">
                {video.description}
              </p>
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
