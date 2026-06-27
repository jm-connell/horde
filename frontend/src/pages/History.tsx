import { useEffect, useState } from "react";
import { api } from "../api";
import VideoCard from "../components/VideoCard";
import type { Video } from "../types";
import { formatRelative } from "../utils";

export default function History() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .listVideos({
        watched_only: true,
        sort: "last_watched_at",
        order: "desc",
      })
      .then(setVideos)
      .catch(() => setVideos([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold text-gray-100">History</h1>

      {loading ? (
        <p className="py-20 text-center text-gray-500">Loading...</p>
      ) : videos.length === 0 ? (
        <div className="py-20 text-center text-gray-500">
          <p className="text-lg">No watch history yet.</p>
          <p className="mt-1 text-sm">
            Videos you watch will appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
          {videos.map((v) => (
            <div key={v.id} className="flex flex-col gap-1">
              <VideoCard video={v} />
              <p className="px-1 text-xs text-gray-500">
                Watched {formatRelative(v.last_watched_at)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
