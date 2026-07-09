import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import LoadingIndicator from "../components/LoadingIndicator";
import VideoCard from "../components/VideoCard";
import type { Video } from "../types";

function dayKey(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(key: string): string {
  if (key === "unknown") return "Unknown";
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  if (target.getTime() === today.getTime()) return "Today";
  if (target.getTime() === yesterday.getTime()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

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

  const groups = useMemo(() => {
    const map = new Map<string, Video[]>();
    for (const v of videos) {
      const key = dayKey(v.last_watched_at);
      const list = map.get(key);
      if (list) list.push(v);
      else map.set(key, [v]);
    }
    return Array.from(map.entries());
  }, [videos]);

  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold text-gray-100">History</h1>

      {loading ? (
        <LoadingIndicator />
      ) : videos.length === 0 ? (
        <div className="py-20 text-center text-gray-500">
          <p className="text-lg">No watch history yet.</p>
          <p className="mt-1 text-sm">
            Videos you watch will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map(([key, dayVideos]) => (
            <section key={key}>
              <div className="mb-4 flex items-center gap-3">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent/80 ring-2 ring-accent/25"
                  aria-hidden
                />
                <h2 className="shrink-0 text-sm font-semibold tracking-wide text-gray-300">
                  {dayLabel(key)}
                </h2>
                <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
                {dayVideos.map((v) => (
                  <div key={v.id} className="flex flex-col gap-1">
                    <VideoCard video={v} />
                    {v.last_watched_at && (
                      <p className="px-1 text-xs text-gray-500">
                        {formatTime(v.last_watched_at)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
