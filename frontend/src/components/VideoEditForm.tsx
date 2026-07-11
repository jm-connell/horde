import { useEffect, useRef, useState } from "react";
import { api, thumbnailUrl } from "../api";
import type { ChannelStat, Video } from "../types";
import { formatDuration, formatResolution, formatSize } from "../utils";
import ChannelPicker from "./ChannelPicker";

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

interface ThumbCandidate {
  index: number;
  at_seconds: number;
  url: string;
}

interface Props {
  video: Video;
  onSaved: (updated: Video) => void;
  onCancel?: () => void;
  saveLabel?: string;
  // Require title + channel before saving (used by the import flow).
  requireChannel?: boolean;
  focusField?: "notes";
}

export default function VideoEditForm({
  video,
  onSaved,
  onCancel,
  saveLabel = "Save",
  requireChannel = false,
  focusField,
}: Props) {
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<DraftState>(toDraft(video));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumbVersion, setThumbVersion] = useState(0);
  const [channels, setChannels] = useState<ChannelStat[]>([]);
  const [candidates, setCandidates] = useState<ThumbCandidate[]>([]);
  const [candIndex, setCandIndex] = useState(0);
  const [candLoading, setCandLoading] = useState(false);
  const [candVersion, setCandVersion] = useState(0);

  useEffect(() => {
    if (focusField === "notes") {
      notesRef.current?.focus();
    }
  }, [focusField]);

  useEffect(() => {
    let active = true;
    api
      .listChannels({ sort: "alphabetical", order: "asc" })
      .then((rows) => {
        if (active) setChannels(rows);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Auto-generate frame picks for import queue items.
  useEffect(() => {
    if (!requireChannel) return;
    let cancelled = false;
    (async () => {
      setCandLoading(true);
      try {
        const res = await api.generateThumbnailCandidates(video.id, 8);
        if (cancelled) return;
        setCandidates(res.candidates);
        setCandIndex(0);
        setCandVersion((v) => v + 1);
        if (res.candidates.length > 0) {
          await api.selectThumbnailCandidate(video.id, res.candidates[0].index);
          if (!cancelled) setThumbVersion((v) => v + 1);
        }
      } catch {
        // Keep the scanner-generated thumb if candidate gen fails.
      } finally {
        if (!cancelled) setCandLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [video.id, requireChannel]);

  // Keep draft in sync when the parent swaps to another video.
  useEffect(() => {
    setDraft(toDraft(video));
    setCandidates([]);
    setCandIndex(0);
    setError(null);
  }, [video.id]);

  const set = (key: keyof DraftState, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const canSave = requireChannel
    ? Boolean(draft.title.trim() && draft.channel.trim())
    : Boolean(draft.title.trim());

  const save = async () => {
    if (!canSave) {
      setError(
        requireChannel
          ? "Title and channel are required to approve."
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
      setCandidates([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const loadCandidates = async () => {
    setCandLoading(true);
    setError(null);
    try {
      const res = await api.generateThumbnailCandidates(video.id, 8);
      setCandidates(res.candidates);
      setCandIndex(0);
      setCandVersion((v) => v + 1);
      if (res.candidates.length > 0) {
        await api.selectThumbnailCandidate(video.id, res.candidates[0].index);
        setThumbVersion((v) => v + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate thumbnails");
    } finally {
      setCandLoading(false);
    }
  };

  const showCandidate = async (next: number) => {
    if (candidates.length === 0) return;
    const idx = (next + candidates.length) % candidates.length;
    setCandIndex(idx);
    try {
      await api.selectThumbnailCandidate(video.id, candidates[idx].index);
      setThumbVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set thumbnail");
    }
  };

  const thumb = thumbnailUrl(video);
  const resLabel = formatResolution(video.height_px);
  const sizeLabel = formatSize(video.file_size);
  const durLabel = formatDuration(video.duration_sec);
  const stats = [resLabel, sizeLabel, durLabel].filter(Boolean).join(" · ");

  const inputClass =
    "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent";
  const labelClass =
    "mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500";

  const activeCand = candidates[candIndex];
  const previewSrc = activeCand
    ? `${activeCand.url}?v=${candVersion}`
    : thumb
      ? `${thumb}?v=${thumbVersion}`
      : null;

  return (
    <div className="ui-panel rounded-xl bg-ink-900 p-5 ring-1 ring-ink-700">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[240px_1fr]">
        <div>
          <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-ink-800">
            {previewSrc ? (
              <img
                src={previewSrc}
                alt={video.title}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-ink-600">
                No thumbnail
              </div>
            )}
            {candidates.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => void showCandidate(candIndex - 1)}
                  className="absolute left-1 top-1/2 -translate-y-1/2 rounded-md bg-ink-950/80 px-2 py-1 text-sm text-gray-100 hover:bg-ink-950"
                  title="Previous frame"
                >
                  ‹
                </button>
                <button
                  type="button"
                  onClick={() => void showCandidate(candIndex + 1)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md bg-ink-950/80 px-2 py-1 text-sm text-gray-100 hover:bg-ink-950"
                  title="Next frame"
                >
                  ›
                </button>
                <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-ink-950/80 px-2 py-0.5 text-[10px] text-gray-300">
                  {candIndex + 1} / {candidates.length}
                </span>
              </>
            )}
          </div>
          <div className="mt-3 space-y-1 text-xs text-gray-500">
            <p className="truncate" title={video.file_path}>
              {video.file_path}
            </p>
            {stats && <p>{stats}</p>}
            {(video.width_px || video.height_px) && (
              <p>
                {video.width_px ?? "?"}×{video.height_px ?? "?"}
                {video.frame_rate ? ` · ${video.frame_rate} fps` : ""}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void loadCandidates()}
            disabled={candLoading}
            className="ui-panel ui-interactive mt-3 w-full rounded-lg bg-ink-800 px-3 py-2 text-xs font-medium text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700 disabled:opacity-50"
          >
            {candLoading
              ? "Generating…"
              : candidates.length
                ? "Regenerate frames"
                : "Auto-generate thumbnails"}
          </button>
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
              <ChannelPicker
                value={draft.channel}
                onChange={(v) => set("channel", v)}
                channels={channels}
                placeholder={
                  requireChannel ? "Type or pick a channel…" : "Channel name"
                }
                autocomplete
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
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label className={labelClass + " mb-0"}>Notes</label>
              <span className="text-[10px] font-medium uppercase tracking-wide text-accent/80">
                Helps AI Features
              </span>
            </div>
            <textarea
              ref={notesRef}
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
                className="ui-panel ui-interactive rounded-lg bg-ink-800 px-5 py-2 text-sm text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700"
              >
                Cancel
              </button>
            )}
            <button
              onClick={save}
              disabled={saving || !canSave}
              className="ui-interactive rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving..." : saveLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
