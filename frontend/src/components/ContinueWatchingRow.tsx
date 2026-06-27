import type { Video } from "../types";
import { useIsMobile } from "../hooks/useIsMobile";
import VideoCard from "./VideoCard";

interface Props {
  videos: Video[];
  onDismiss: (id: number) => void;
  onDismissAll: (ids: number[]) => void;
}

function watchProgress(video: Video): number | undefined {
  if (!video.duration_sec || video.duration_sec <= 0) return undefined;
  return Math.min(1, video.last_position_sec / video.duration_sec);
}

export default function ContinueWatchingRow({
  videos,
  onDismiss,
  onDismissAll,
}: Props) {
  const isMobile = useIsMobile();

  if (videos.length === 0) return null;

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          Continue watching
        </h2>
        <button
          onClick={() => onDismissAll(videos.map((v) => v.id))}
          className="text-xs text-gray-500 hover:text-accent"
        >
          Clear all
        </button>
      </div>

      {isMobile ? (
        <div className="flex gap-4 overflow-x-auto pb-1">
          {videos.map((v) => (
            <div key={v.id} className="relative w-64 shrink-0">
              <button
                onClick={() => onDismiss(v.id)}
                className="absolute right-2 top-2 z-10 rounded-full bg-black/70 px-1.5 py-0.5 text-xs text-gray-300 hover:bg-black hover:text-white"
                title="Remove from continue watching"
                aria-label="Remove from continue watching"
              >
                ✕
              </button>
              <VideoCard
                video={v}
                progress={watchProgress(v)}
                hideQueueButton
              />
            </div>
          ))}
        </div>
      ) : (
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${videos.length}, minmax(0, 1fr))`,
          }}
        >
          {videos.map((v) => (
            <div key={v.id} className="group relative min-w-0">
              <button
                onClick={() => onDismiss(v.id)}
                className="absolute right-2 top-2 z-10 rounded-full bg-black/70 px-1.5 py-0.5 text-xs text-gray-300 opacity-0 transition-opacity hover:bg-black hover:text-white group-hover:opacity-100"
                title="Remove from continue watching"
                aria-label="Remove from continue watching"
              >
                ✕
              </button>
              <VideoCard
                video={v}
                progress={watchProgress(v)}
                hideQueueButton
              />
            </div>
          ))}
        </div>
      )}

      <hr className="mt-8 border-ink-700/80" />
    </section>
  );
}
