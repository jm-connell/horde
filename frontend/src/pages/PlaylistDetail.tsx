import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, thumbnailUrl } from "../api";
import LoadingIndicator from "../components/LoadingIndicator";
import { usePlayback } from "../context/PlaybackContext";
import type { PlaylistDetail as PlaylistDetailType } from "../types";
import { formatDuration } from "../utils";

export default function PlaylistDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const playlistId = Number(id);
  const [playlist, setPlaylist] = useState<PlaylistDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { playVideo, addToQueue } = usePlayback();

  const load = () => {
    api
      .getPlaylist(playlistId)
      .then(setPlaylist)
      .catch(() => setError("Playlist not found"));
  };

  useEffect(() => {
    if (playlistId) load();
  }, [playlistId]);

  const playAll = () => {
    if (!playlist || playlist.videos.length === 0) return;
    const [first, ...rest] = playlist.videos;
    playVideo(first, { queue: rest });
    navigate(`/watch/${first.id}`);
  };

  const remove = async (videoId: number) => {
    if (!playlist) return;
    await api.removeFromPlaylist(playlist.id, videoId).catch(() => undefined);
    load();
  };

  const onDelete = async () => {
    if (!playlist) return;
    if (!confirm(`Delete playlist "${playlist.name}"?`)) return;
    await api.deletePlaylist(playlist.id);
    navigate("/playlists");
  };

  if (error) {
    return <p className="py-20 text-center text-gray-500">{error}</p>;
  }
  if (!playlist) {
    return <LoadingIndicator />;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        to="/playlists"
        className="text-sm text-gray-400 hover:text-accent"
      >
        ← Playlists
      </Link>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold text-gray-100">
            {playlist.name}
          </h1>
          <p className="text-sm text-gray-500">
            {playlist.videos.length} video
            {playlist.videos.length === 1 ? "" : "s"}
            {playlist.source_type === "youtube" && " · imported from YouTube"}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={playAll}
            disabled={playlist.videos.length === 0}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:opacity-50"
          >
            ▶ Play all
          </button>
          <button
            onClick={onDelete}
            className="rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10"
          >
            Delete
          </button>
        </div>
      </div>

      {playlist.source_url && (
        <a
          href={playlist.source_url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-sm text-accent hover:underline"
        >
          Source playlist ↗
        </a>
      )}

      <div className="mt-5 space-y-2">
        {playlist.videos.length === 0 ? (
          <p className="py-16 text-center text-gray-500">
            {playlist.source_type === "youtube"
              ? "Videos will appear here as they finish downloading."
              : "No videos yet. Add some from the library or watch page."}
          </p>
        ) : (
          playlist.videos.map((v, i) => {
            const thumb = thumbnailUrl(v);
            return (
              <div
                key={v.id}
                className="flex items-center gap-3 rounded-xl bg-ink-900 p-2 ring-1 ring-ink-700"
              >
                <span className="w-6 shrink-0 text-center text-sm text-gray-500">
                  {i + 1}
                </span>
                <Link
                  to={`/watch/${v.id}`}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded bg-ink-800">
                    {thumb && (
                      <img
                        src={thumb}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-100">
                      {v.title}
                    </p>
                    <p className="text-xs text-gray-500">
                      {v.channel} · {formatDuration(v.duration_sec)}
                    </p>
                  </div>
                </Link>
                <button
                  onClick={() => addToQueue(v)}
                  className="shrink-0 rounded px-2 py-1 text-xs text-gray-400 hover:text-accent"
                  title="Add to queue"
                >
                  + Queue
                </button>
                <button
                  onClick={() => remove(v.id)}
                  className="shrink-0 px-2 text-gray-500 hover:text-accent"
                  title="Remove from playlist"
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
