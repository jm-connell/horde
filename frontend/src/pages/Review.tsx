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
            <VideoEditForm
              key={v.id}
              video={v}
              requireChannel
              saveLabel="Save & approve"
              onSaved={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}
