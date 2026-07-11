import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import LoadingIndicator from "../components/LoadingIndicator";
import VideoEditForm from "../components/VideoEditForm";
import { useToast } from "../context/ToastContext";
import type { DuplicateGroup, Video } from "../types";
import { notifyImportQueueChanged } from "../utils/importQueue";
import { formatSize } from "../utils";

const VIDEO_ACCEPT = ".mp4,.mkv,.webm,video/mp4,video/webm,video/x-matroska";
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm"]);

function verdictLabel(group: DuplicateGroup): string | null {
  if (group.match_type === "youtube_id") return "Same YouTube ID";
  if (!group.ai_verdict) return null;
  const conf =
    group.ai_confidence != null
      ? ` (${Math.round(group.ai_confidence * 100)}%)`
      : "";
  const label =
    group.ai_verdict === "same"
      ? "Likely same"
      : group.ai_verdict === "similar"
        ? "Similar"
        : "Probably different";
  return `${label}${conf}`;
}

function isVideoFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_EXTS.has(name.slice(dot));
}

interface UploadItem {
  id: string;
  name: string;
  size: number;
  pct: number;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
}

export default function Import() {
  const { showToast } = useToast();
  const [items, setItems] = useState<Video[]>([]);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.listImport().catch(() => [] as Video[]),
      api.listDuplicateGroups().catch(() => [] as DuplicateGroup[]),
    ])
      .then(([review, dupes]) => {
        setItems(review);
        setGroups(dupes);
        notifyImportQueueChanged(review.length);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const processFiles = useCallback(
    async (files: File[]) => {
      const videos = files.filter(isVideoFile);
      if (videos.length === 0) {
        showToast("No supported video files (.mp4, .mkv, .webm)");
        return;
      }
      if (uploadingRef.current) {
        showToast("Wait for the current upload to finish");
        return;
      }
      uploadingRef.current = true;
      const batch: UploadItem[] = videos.map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`,
        name: f.name,
        size: f.size,
        pct: 0,
        status: "queued" as const,
      }));
      setUploads(batch);

      for (let i = 0; i < videos.length; i++) {
        const file = videos[i];
        const id = batch[i].id;
        setUploads((prev) =>
          prev.map((u) =>
            u.id === id ? { ...u, status: "uploading", pct: 0 } : u
          )
        );
        try {
          await api.uploadImportVideo(file, (pct) => {
            setUploads((prev) =>
              prev.map((u) => (u.id === id ? { ...u, pct } : u))
            );
          });
          setUploads((prev) =>
            prev.map((u) =>
              u.id === id ? { ...u, status: "done", pct: 100 } : u
            )
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Upload failed";
          setUploads((prev) =>
            prev.map((u) =>
              u.id === id ? { ...u, status: "error", error: msg } : u
            )
          );
          showToast(`${file.name}: ${msg}`);
        }
      }

      uploadingRef.current = false;
      load();
      window.setTimeout(() => {
        setUploads((prev) =>
          prev.every((u) => u.status === "done" || u.status === "error")
            ? []
            : prev
        );
      }, 2500);
    },
    [load, showToast]
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const list = Array.from(e.dataTransfer.files);
    void processFiles(list);
  };

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Import</h1>
      <p className="mb-6 text-sm text-gray-400">
        Drop videos here or into your media folder. Add a title and channel to
        move them into the library.
      </p>

      <div
        onDragEnter={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragOver(false);
        }}
        onDrop={onDrop}
        className={`mb-6 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragOver
            ? "border-accent bg-accent/10"
            : "border-ink-600 bg-ink-900/50"
        }`}
      >
        <p className="text-sm text-gray-300">
          Drop .mp4, .mkv, or .webm files here
        </p>
        <p className="mt-1 text-xs text-gray-500">or</p>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="ui-panel ui-interactive mt-2 rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700"
        >
          Choose files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={VIDEO_ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []);
            e.target.value = "";
            void processFiles(list);
          }}
        />
      </div>

      {uploads.length > 0 && (
        <div className="mb-6 space-y-2">
          {uploads.map((u) => (
            <div
              key={u.id}
              className="ui-panel rounded-lg bg-ink-900 px-3 py-2 ring-1 ring-ink-700"
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-gray-300">
                  {u.name}
                  {u.size > 0 && (
                    <span className="ml-2 text-gray-500">
                      {formatSize(u.size)}
                    </span>
                  )}
                </span>
                <span
                  className={
                    u.status === "error"
                      ? "shrink-0 text-red-400"
                      : u.status === "done"
                        ? "shrink-0 text-accent"
                        : "shrink-0 text-gray-500"
                  }
                >
                  {u.status === "error"
                    ? u.error || "Error"
                    : u.status === "done"
                      ? "Done"
                      : u.status === "queued"
                        ? "Queued"
                        : `${u.pct}%`}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
                <div
                  className={`h-full transition-all ${
                    u.status === "error" ? "bg-red-500" : "bg-accent"
                  }`}
                  style={{
                    width: `${
                      u.status === "done"
                        ? 100
                        : u.status === "error"
                          ? 100
                          : u.pct
                    }%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <LoadingIndicator />
      ) : items.length === 0 && groups.length === 0 ? (
        <div className="py-12 text-center text-gray-500">
          <p className="text-lg">Nothing to import.</p>
          <p className="mt-1 text-sm">Drop files above to get started.</p>
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
                        await api.skipImport(v.id).catch(() => undefined);
                        load();
                      }}
                      className="ui-panel ui-interactive rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700"
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
                      className="ui-panel ui-interactive rounded-lg border border-red-500/40 bg-ink-900 px-4 py-2 text-sm text-red-400 ring-1 ring-ink-700 hover:bg-red-500/10"
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
                  {groups.map((group, gi) => {
                    const label = verdictLabel(group);
                    return (
                      <div
                        key={gi}
                        className="ui-panel rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700"
                      >
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                            Duplicate group {gi + 1}
                          </p>
                          {label && (
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                group.ai_verdict === "different"
                                  ? "bg-ink-800 text-gray-400"
                                  : group.ai_verdict === "similar"
                                    ? "bg-amber-500/15 text-amber-300"
                                    : "bg-accent/15 text-accent"
                              }`}
                              title={group.ai_reason || undefined}
                            >
                              {label}
                            </span>
                          )}
                        </div>
                        <div className="space-y-3">
                          {group.videos.map((v) => (
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
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
