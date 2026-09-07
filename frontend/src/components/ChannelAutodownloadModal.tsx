import { useEffect, useState } from "react";
import ThemedSelect from "./ThemedSelect";
import { PRESET_LABELS, PRESET_ORDER } from "../presets";
import type { ChannelAutodownload } from "../types";
import { Toggle } from "../pages/settings/ui";

const labelClass = "mb-1 block text-xs font-medium text-gray-400";

type PreviousMode = ChannelAutodownload["previous_mode"];

export default function ChannelAutodownloadModal({
  channel,
  policy,
  saving,
  onClose,
  onSave,
}: {
  channel: string;
  policy: ChannelAutodownload;
  saving: boolean;
  onClose: () => void;
  onSave: (payload: {
    enabled: boolean;
    previous_mode: PreviousMode;
    previous_count: number;
    quality_preset: string;
    include_completed_streams: boolean;
  }) => void;
}) {
  const [previousMode, setPreviousMode] = useState<PreviousMode>(
    policy.previous_mode
  );
  const [previousCount, setPreviousCount] = useState(
    String(policy.previous_count && policy.previous_count > 0 ? policy.previous_count : 10)
  );
  const [qualityPreset, setQualityPreset] = useState(
    policy.quality_preset || "1080p"
  );
  const [includeStreams, setIncludeStreams] = useState(
    policy.include_completed_streams
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const countNum = Math.max(1, Math.min(500, parseInt(previousCount, 10) || 10));
  const allPrevious = previousMode === "all";
  const qualityOptions = PRESET_ORDER.map((p) => ({
    value: p,
    label: PRESET_LABELS[p] ?? p,
  }));

  const saveEnabled = () =>
    onSave({
      enabled: true,
      previous_mode: previousMode,
      previous_count: countNum,
      quality_preset: qualityPreset,
      include_completed_streams: includeStreams,
    });

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="autodownload-title"
    >
      <div
        className="ui-panel ui-panel-legible max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-ink-700 bg-ink-900 p-6 shadow-2xl ring-1 ring-ink-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2
              id="autodownload-title"
              className="text-lg font-semibold text-gray-100"
            >
              Autodownload
            </h2>
            <p className="mt-0.5 text-sm text-gray-500">{channel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
            allPrevious
              ? "border-amber-500/40 bg-amber-500/10 text-amber-100/90"
              : "border-amber-500/30 bg-amber-500/10 text-amber-200/90"
          }`}
        >
          {allPrevious
            ? `Downloading all previous videos can use a lot of storage. This is limited to the channel catalog cap (${policy.catalog_max_videos} videos).`
            : "Autodownload can use a lot of storage over time, especially if you include previous videos."}
        </div>

        <fieldset className="mb-4 space-y-2">
          <legend className={labelClass}>What to download</legend>
          <label className="flex items-start gap-2 text-sm text-gray-200">
            <input
              type="radio"
              name="autodownload-scope"
              checked={previousMode === "none"}
              onChange={() => setPreviousMode("none")}
              className="mt-1"
            />
            <span>Future videos only</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-200">
            <input
              type="radio"
              name="autodownload-scope"
              checked={previousMode === "count"}
              onChange={() => setPreviousMode("count")}
              className="mt-1"
            />
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              Last
              <input
                type="number"
                min={1}
                max={500}
                value={previousCount}
                onChange={(e) => setPreviousCount(e.target.value)}
                onFocus={() => setPreviousMode("count")}
                className="w-16 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-gray-100 outline-none focus:border-accent"
              />
              previous + all future
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-200">
            <input
              type="radio"
              name="autodownload-scope"
              checked={previousMode === "all"}
              onChange={() => setPreviousMode("all")}
              className="mt-1"
            />
            <span>All previous indexed videos + all future</span>
          </label>
        </fieldset>

        <div className="mb-4">
          <label className={labelClass} htmlFor="autodownload-quality">
            Resolution
          </label>
          <ThemedSelect
            aria-label="Autodownload resolution"
            value={qualityPreset}
            options={qualityOptions}
            onChange={setQualityPreset}
            className="w-full"
            buttonClassName="w-full"
          />
        </div>

        <div className="mb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-gray-200">
                Include completed livestreams
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                Livestreams are never downloaded while live or upcoming. When
                this is on, finished stream recordings are included.
              </p>
            </div>
            <Toggle
              checked={includeStreams}
              onChange={() => setIncludeStreams((v) => !v)}
            />
          </div>
        </div>

        {policy.pending_estimate > 0 && (
          <p className="mb-4 text-xs text-gray-500">
            About {policy.pending_estimate} catalog video
            {policy.pending_estimate === 1 ? "" : "s"} not already in your
            library would be queued with the current previous-video setting.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={saveEnabled}
            disabled={saving}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-60"
          >
            {saving ? "Saving…" : policy.enabled ? "Save" : "Enable autodownload"}
          </button>
          {policy.configured && policy.enabled && (
            <button
              type="button"
              onClick={() =>
                onSave({
                  enabled: false,
                  previous_mode: previousMode,
                  previous_count: countNum,
                  quality_preset: qualityPreset,
                  include_completed_streams: includeStreams,
                })
              }
              disabled={saving}
              className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700 disabled:opacity-60"
            >
              Turn off
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
