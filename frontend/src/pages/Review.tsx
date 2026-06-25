import { useEffect, useState } from "react";
import { api } from "../api";
import VideoEditForm from "../components/VideoEditForm";
import type { Video } from "../types";

export default function Review() {
  const [items, setItems] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api
      .listReview()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Review needed</h1>
      <p className="mb-6 text-sm text-gray-400">
        Files dropped into your media folder appear here. Add a title and channel
        to move them into the library.
      </p>

      {loading ? (
        <p className="py-20 text-center text-gray-500">Loading...</p>
      ) : items.length === 0 ? (
        <div className="py-20 text-center text-gray-500">
          <p className="text-lg">Nothing to review.</p>
          <p className="mt-1 text-sm">All caught up.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {items.map((v) => (
            <div key={v.id} className="space-y-2">
              <VideoEditForm
                video={v}
                requireChannel
                saveLabel="Save & approve"
                onSaved={load}
              />
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    await api.skipReview(v.id).catch(() => undefined);
                    load();
                  }}
                  className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
                  title="Keep in library without a channel"
                >
                  Skip
                </button>
                <button
                  onClick={async () => {
                    if (!confirm(`Delete "${v.title}" and its file?`)) return;
                    await api.deleteVideo(v.id, true).catch(() => undefined);
                    load();
                  }}
                  className="rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
