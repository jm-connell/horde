import {
  formatApproxSize,
  mergePinnedPreset,
  PRESET_ORDER,
  presetOptionLabel,
} from "../presets";
import type { ChannelStat } from "../types";
import type { PendingChannelDownload } from "../hooks/useChannelDownloadQueue";
import { youtubeThumbnailUrl } from "../utils";
import ChannelDownloadEditModal from "./ChannelDownloadEditModal";

export default function ChannelDownloadPanel({
  defaultPreset,
  onDefaultPresetChange,
  allPresets,
  pending,
  channels,
  editingId,
  onSetEditingId,
  onUpdatePending,
  onCancel,
  onSubmitNow,
}: {
  defaultPreset: string;
  onDefaultPresetChange: (preset: string) => void;
  allPresets: string[];
  pending: PendingChannelDownload[];
  channels: ChannelStat[];
  editingId: number | null;
  onSetEditingId: (id: number | null) => void;
  onUpdatePending: (
    tempId: number,
    patch: Partial<PendingChannelDownload>
  ) => void;
  onCancel: (tempId: number) => void;
  onSubmitNow: (tempId: number) => void;
}) {
  const editingItem = pending.find((p) => p.tempId === editingId) ?? null;
  const presetOptions =
    allPresets.length > 0 ? allPresets : [...PRESET_ORDER];

  if (pending.length === 0) {
    return (
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)]">
        <div className="pointer-events-auto rounded-xl bg-ink-900 p-4 shadow-2xl ring-1 ring-ink-700">
          <label className="mb-1 block text-xs font-medium text-gray-400">
            Download resolution
          </label>
          <select
            value={defaultPreset}
            onChange={(e) => onDefaultPresetChange(e.target.value)}
            className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
          >
            {presetOptions.map((p) => (
              <option key={p} value={p}>
                {presetOptionLabel(p, undefined)}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
        <div className="pointer-events-auto rounded-xl bg-ink-900 p-3 shadow-2xl ring-1 ring-ink-700">
          <label className="mb-1 block text-xs font-medium text-gray-400">
            Download resolution
          </label>
          <select
            value={defaultPreset}
            onChange={(e) => onDefaultPresetChange(e.target.value)}
            className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
          >
            {presetOptions.map((p) => (
              <option key={p} value={p}>
                {presetOptionLabel(p, undefined)}
              </option>
            ))}
          </select>
        </div>

        {pending.map((item) => {
          const preview = item.preview;
          const qualityOptions =
            preview &&
            !preview.is_playlist &&
            preview.available_presets.length > 0
              ? mergePinnedPreset(preview.available_presets, item.preset)
              : presetOptions;
          const sizeLabel = item.previewLoading
            ? "…"
            : formatApproxSize(preview?.preset_sizes?.[item.preset]);
          const thumbSrc = youtubeThumbnailUrl(
            item.entry.id,
            item.entry.thumbnail_url
          );

          return (
            <div
              key={item.tempId}
              className="pointer-events-auto rounded-xl bg-ink-900 p-3 shadow-2xl ring-1 ring-ink-700"
            >
              <div className="flex gap-3">
                <div className="h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-ink-800">
                  {thumbSrc ? (
                    <img
                      src={thumbSrc}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[10px] text-gray-600">
                      No preview
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium text-gray-100">
                    {item.title || item.entry.title || "Untitled"}
                  </p>
                  <p className="truncate text-xs text-gray-500">{item.channel}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <select
                      value={item.preset}
                      onChange={(e) =>
                        onUpdatePending(item.tempId, { preset: e.target.value })
                      }
                      className="max-w-full flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-gray-100 outline-none focus:border-accent"
                    >
                      {qualityOptions.map((p) => (
                        <option key={p} value={p}>
                          {presetOptionLabel(p, preview?.preset_sizes)}
                        </option>
                      ))}
                    </select>
                    {sizeLabel && (
                      <span className="text-xs text-gray-500">{sizeLabel}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-gray-500">
                  {item.submitting
                    ? "Starting…"
                    : `Downloading in ${item.secondsLeft}s`}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => onSetEditingId(item.tempId)}
                    className="rounded-md bg-ink-800 px-2 py-1 text-xs text-gray-300 hover:bg-ink-700"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => onSubmitNow(item.tempId)}
                    disabled={item.submitting}
                    className="rounded-md bg-accent/15 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/25 disabled:opacity-50"
                  >
                    Now
                  </button>
                  <button
                    type="button"
                    onClick={() => onCancel(item.tempId)}
                    disabled={item.submitting}
                    className="rounded-md px-2 py-1 text-xs text-gray-500 hover:text-red-400 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editingItem && (
        <ChannelDownloadEditModal
          item={editingItem}
          allPresets={allPresets}
          channels={channels}
          onClose={() => onSetEditingId(null)}
          onSave={(patch) => onUpdatePending(editingItem.tempId, patch)}
          onDownloadNow={() => {
            onSubmitNow(editingItem.tempId);
            onSetEditingId(null);
          }}
        />
      )}
    </>
  );
}
