import { useId, useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import ChannelPicker from "./ChannelPicker";
import { mergePinnedPreset, PRESET_ORDER, presetOptionLabel } from "../presets";
import type { ChannelStat } from "../types";
import type { PendingChannelDownload } from "../hooks/useChannelDownloadQueue";
import { backdropClick, youtubeThumbnailUrl } from "../utils";
import ThemedSelect from "./ThemedSelect";
import { CloseIcon } from "./icons";
import { button } from "./buttons";
import { DIALOG_BACKDROP_ENTER, DIALOG_PANEL_ENTER } from "./dialogMotion";

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
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onEscape: onClose });
  const titleInputId = useId();
  const noteInputId = useId();
  const dialogTitleId = useId();
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
      className={`fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4 ${DIALOG_BACKDROP_ENTER}`}
      role="presentation"
      onClick={backdropClick(onClose)}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        className={`max-h-[90vh] w-full max-w-lg overflow-y-auto outline-hidden rounded-xl bg-ink-900 p-6 shadow-2xl ring-1 ring-ink-700 ${DIALOG_PANEL_ENTER}`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2
            id={dialogTitleId}
            className="text-lg font-semibold text-gray-100"
          >
            Edit download
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-gray-300"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="mb-4 flex gap-3">
          {thumbSrc && (
            <img
              loading="lazy"
              decoding="async"
              width={112}
              height={64}
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
            <label htmlFor={titleInputId} className={labelClass}>
              Title
            </label>
            <input
              id={titleInputId}
              value={item.title}
              onChange={(e) => onSave({ title: e.target.value })}
              className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-hidden focus:border-accent"
            />
          </div>
          <div>
            <span className={labelClass}>Channel</span>
            <ChannelPicker
              value={item.channel}
              onChange={(channel) => onSave({ channel })}
              channels={channels}
              placeholder="Channel"
            />
          </div>
          <div>
            <span className={labelClass}>Resolution</span>
            <ThemedSelect
              aria-label="Resolution"
              value={item.preset}
              options={qualityOptions.map((p) => ({
                value: p,
                label: presetOptionLabel(p, preview?.preset_sizes),
              }))}
              onChange={(preset) => onSave({ preset })}
              className="w-full"
              buttonClassName="w-full"
            />
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label htmlFor={noteInputId} className={labelClass + " mb-0"}>
                Note
              </label>
            </div>
            <textarea
              id={noteInputId}
              value={item.notes}
              onChange={(e) => onSave({ notes: e.target.value })}
              rows={3}
              placeholder="Personal note about this video…"
              className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-hidden focus:border-accent"
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onDownloadNow}
            disabled={item.submitting}
            className={button("primary")}
          >
            Download now
          </button>
          <button
            type="button"
            onClick={onClose}
            className={button("secondary")}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
