import { useState } from "react";
import { api, thumbnailUrl } from "../api";
import type { Video } from "../types";
import { formatDuration, formatSize } from "../utils";

interface DraftState {
  title: string;
  channel: string;
  channel_url: string;
  tags: string;
  description: string;
  notes: string;
  source_url: string;
  published_at: string;
  thumbnail_url: string;
}

function toDraft(v: Video): DraftState {
  return {
    title: v.title ?? "",
    channel: v.channel ?? "",
    channel_url: v.channel_url ?? "",
    tags: v.tags.join(", "),
    description: v.description ?? "",
    notes: v.notes ?? "",
    source_url: v.source_url ?? "",
    published_at: v.published_at ? v.published_at.slice(0, 10) : "",
    thumbnail_url: "",
  };
}

interface Props {
  video: Video;
  onSaved: (updated: Video) => void;
  onCancel?: () => void;
  saveLabel?: string;
  // Require title + channel before saving (used by the review flow).
  requireChannel?: boolean;
}

export default function VideoEditForm({
  video,
  onSaved,
  onCancel,
  saveLabel = "Save",
  requireChannel = false,
}: Props) {
  const [draft, setDraft] = useState<DraftState>(toDraft(video));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumbVersion, setThumbVersion] = useState(0);

  const set = (key: keyof DraftState, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const canSave = requireChannel
    ? Boolean(draft.title.trim() && draft.channel.trim())
    : Boolean(draft.title.trim());

  const save = async () => {
    if (!canSave) {
      setError(
        requireChannel
          ? "Title and channel are required to clear review."
          : "Title is required."
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateVideo(video.id, {
        title: draft.title.trim(),
        channel: draft.channel.trim() || undefined,
        channel_url: draft.channel_url.trim() || null,
        tags: draft.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        description: draft.description.trim() || undefined,
        notes: draft.notes.trim() || null,
        source_url: draft.source_url.trim() || undefined,
        published_at: draft.published_at
          ? new Date(draft.published_at).toISOString()
          : null,
        thumbnail_url: draft.thumbnail_url.trim() || undefined,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await api.uploadThumbnail(video.id, file);
      setThumbVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const thumb = thumbnailUrl(video);

  const inputClass =
    "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent";
  const labelClass =
    "mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500";

  return (
    <div className="rounded-xl bg-ink-900 p-5 ring-1 ring-ink-700">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[240px_1fr]">
        <div>
          <div className="aspect-video w-full overflow-hidden rounded-lg bg-ink-800">
            {thumb ? (
              <img
                src={`${thumb}?v=${thumbVersion}`}
                alt={video.title}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-ink-600">
                No thumbnail
              </div>
            )}
          </div>
          <div className="mt-3 space-y-1 text-xs text-gray-500">
            <p className="truncate" title={video.file_path}>
              {video.file_path}
            </p>
            <p>
              {formatDuration(video.duration_sec)} · {formatSize(video.file_size)}
            </p>
          </div>
          <label className="mt-3 block">
            <span className={labelClass}>Upload thumbnail</span>
            <input
              type="file"
              accept="image/*"
              onChange={onUpload}
              className="block w-full text-xs text-gray-400 file:mr-3 file:rounded-md file:border-0 file:bg-ink-700 file:px-3 file:py-1.5 file:text-xs file:text-accent hover:file:bg-ink-600"
            />
          </label>
          <div className="mt-2">
            <span className={labelClass}>Or thumbnail URL</span>
            <input
              value={draft.thumbnail_url}
              onChange={(e) => set("thumbnail_url", e.target.value)}
              placeholder="https://..."
              className={inputClass}
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>
                Title{requireChannel ? " *" : ""}
              </label>
              <input
                value={draft.title}
                onChange={(e) => set("title", e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>
                Channel{requireChannel ? " *" : ""}
              </label>
              <input
                value={draft.channel}
                onChange={(e) => set("channel", e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Tags (comma separated)</label>
              <input
                value={draft.tags}
                onChange={(e) => set("tags", e.target.value)}
                placeholder="music, live, 2024"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Publish date</label>
              <input
                type="date"
                value={draft.published_at}
                onChange={(e) => set("published_at", e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Source URL</label>
              <input
                value={draft.source_url}
                onChange={(e) => set("source_url", e.target.value)}
                placeholder="https://..."
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Channel URL</label>
              <input
                value={draft.channel_url}
                onChange={(e) => set("channel_url", e.target.value)}
                placeholder="https://..."
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Description</label>
            <textarea
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              rows={3}
              className={`${inputClass} resize-y`}
            />
          </div>

          <div>
            <label className={labelClass}>Notes</label>
            <textarea
              value={draft.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
              placeholder="Personal note about this video..."
              className={`${inputClass} resize-y`}
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            {onCancel && (
              <button
                onClick={onCancel}
                className="rounded-lg bg-ink-800 px-5 py-2 text-sm text-gray-200 hover:bg-ink-700"
              >
                Cancel
              </button>
            )}
            <button
              onClick={save}
              disabled={saving || !canSave}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving..." : saveLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
