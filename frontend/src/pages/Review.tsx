import { useEffect, useState } from "react";
import { api } from "../api";
import LoadingIndicator from "../components/LoadingIndicator";
import VideoEditForm from "../components/VideoEditForm";
import { useToast } from "../context/ToastContext";
import type { Video } from "../types";

export default function Review() {
  const { showToast } = useToast();
  const [items, setItems] = useState<Video[]>([]);
  const [groups, setGroups] = useState<Video[][]>([]);
  const [loading, setLoading] = useState(true);
  const [showDuplicates, setShowDuplicates] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.listReview().catch(() => [] as Video[]),
      fetch("/api/review/groups")
        .then((r) => r.json() as Promise<Video[][]>)
        .catch(() => [] as Video[][]),
    ])
      .then(([review, dupes]) => {
        setItems(review);
        setGroups(dupes);
      })
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
        <LoadingIndicator />
      ) : items.length === 0 && groups.length === 0 ? (
        <div className="py-20 text-center text-gray-500">
          <p className="text-lg">Nothing to review.</p>
          <p className="mt-1 text-sm">All caught up.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {items.length > 0 && (
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
                      className="ui-panel rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
                      title="Keep in library without a channel"
                    >
                      Skip
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete "${v.title}" and its file?`)) return;
                        try {
                          await api.deleteVideo(v.id, true);
                          load();
                        } catch {
                          showToast("Could not delete video");
                        }
                      }}
                      className="ui-panel rounded-lg border border-red-500/40 bg-ink-900 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {groups.length > 0 && (
            <div>
              <button
                onClick={() => setShowDuplicates((v) => !v)}
                className="mb-4 flex items-center gap-2 text-sm font-medium text-gray-300 hover:text-accent"
              >
                <span>{showDuplicates ? "▼" : "▶"}</span>
                <span>
                  Possible duplicates ({groups.length} group
                  {groups.length === 1 ? "" : "s"})
                </span>
              </button>

              {showDuplicates && (
                <div className="space-y-6">
                  {groups.map((group, gi) => (
                    <div
                      key={gi}
                      className="ui-panel rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700"
                    >
                      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500">
                        Duplicate group {gi + 1}
                      </p>
                      <div className="space-y-3">
                        {group.map((v) => (
                          <div
                            key={v.id}
                            className="ui-card flex items-center justify-between gap-3 rounded-lg bg-ink-800 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-gray-200">
                                {v.title}
                              </p>
                              <p className="text-xs text-gray-500">
                                {v.channel} · {v.file_path}
                              </p>
                            </div>
                            <button
                              onClick={async () => {
                                if (
                                  !confirm(
                                    `Delete "${v.title}" and its file?`
                                  )
                                )
                                  return;
                                try {
                                  await api.deleteVideo(v.id, true);
                                  load();
                                } catch {
                                  showToast("Could not delete video");
                                }
                              }}
                              className="shrink-0 rounded border border-red-500/40 px-3 py-1 text-xs text-red-400 hover:bg-red-500/10"
                            >
                              Delete
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
