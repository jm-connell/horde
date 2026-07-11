import ChannelPicker from "./ChannelPicker";
import {
  mergePinnedPreset,
  PRESET_ORDER,
  presetOptionLabel,
} from "../presets";
import type { ChannelStat } from "../types";
import type { PendingChannelDownload } from "../hooks/useChannelDownloadQueue";
import { youtubeThumbnailUrl } from "../utils";

const labelClass = "mb-1 block text-xs font-medium text-gray-400";

export default function ChannelDownloadEditModal({
  item,
  allPresets,
  channels,
  onClose,
  onSave,
  onDownloadNow,
}: {
  item: PendingChannelDownload;
  allPresets: string[];
  channels: ChannelStat[];
  onClose: () => void;
  onSave: (patch: Partial<PendingChannelDownload>) => void;
  onDownloadNow: () => void;
}) {
  const preview = item.preview;
  const qualityOptions =
    preview && !preview.is_playlist && preview.available_presets.length > 0
      ? mergePinnedPreset(preview.available_presets, item.preset)
      : allPresets.length > 0
        ? allPresets
        : [...PRESET_ORDER];

  const thumbSrc = youtubeThumbnailUrl(item.entry.id, item.entry.thumbnail_url);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-ink-900 p-6 shadow-2xl ring-1 ring-ink-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-100">Edit download</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="mb-4 flex gap-3">
          {thumbSrc && (
            <img
              src={thumbSrc}
              alt=""
              className="h-16 w-28 shrink-0 rounded-lg object-cover"
            />
          )}
          <p className="line-clamp-3 text-sm text-gray-400">
            {item.entry.title || item.entry.url}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className={labelClass}>Title</label>
            <input
              value={item.title}
              onChange={(e) => onSave({ title: e.target.value })}
              className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className={labelClass}>Channel</label>
            <ChannelPicker
              value={item.channel}
              onChange={(channel) => onSave({ channel })}
              channels={channels}
              placeholder="Channel"
            />
          </div>
          <div>
            <label className={labelClass}>Resolution</label>
            <select
              value={item.preset}
              onChange={(e) => onSave({ preset: e.target.value })}
              className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
            >
              {qualityOptions.map((p) => (
                <option key={p} value={p}>
                  {presetOptionLabel(p, preview?.preset_sizes)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label className={labelClass + " mb-0"}>Note</label>
              <span className="text-[10px] font-medium uppercase tracking-wide text-accent/80">
                Helps AI Features
              </span>
            </div>
            <textarea
              value={item.notes}
              onChange={(e) => onSave({ notes: e.target.value })}
              rows={3}
              placeholder="Personal note about this video..."
              className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onDownloadNow}
            disabled={item.submitting}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-60"
          >
            Download now
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
