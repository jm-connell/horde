import { useEffect, useState } from "react";
import { api } from "../api";
import { useSettings, type SubtitleSize } from "../hooks/useSettings";
import type { ViewMode } from "../components/VideoPlayer";
import type { StorageStats } from "../types";
import { formatSize } from "../utils";

const MODE_OPTIONS: { value: ViewMode; label: string; hint: string }[] = [
  { value: "standard", label: "Normal", hint: "Centered player" },
  { value: "theater", label: "Theater", hint: "Wide player layout" },
  { value: "windowed", label: "Fullscreen", hint: "Fills the window" },
];

const SUBTITLE_SIZES: { value: SubtitleSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export default function Settings() {
  const [settings, update] = useSettings();
  const [storage, setStorage] = useState<StorageStats | null>(null);

  useEffect(() => {
    api.storageStats().then(setStorage).catch(() => undefined);
  }, []);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Settings</h1>
      <p className="mb-6 text-sm text-gray-400">
        Preferences are stored in this browser.
      </p>

      <div className="space-y-6 rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700">
        <div>
          <h2 className="mb-1 text-sm font-medium text-gray-200">
            Default playback mode
          </h2>
          <p className="mb-3 text-xs text-gray-500">
            How a video opens on the watch page.
          </p>
          <div className="flex flex-wrap gap-2">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => update({ defaultPlaybackMode: opt.value })}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  settings.defaultPlaybackMode === opt.value
                    ? "bg-accent text-ink-950"
                    : "bg-ink-800 text-gray-300 hover:bg-ink-700"
                }`}
                title={opt.hint}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-ink-700 pt-6">
          <label className="flex items-center justify-between">
            <span>
              <span className="block text-sm font-medium text-gray-200">
                Show description
              </span>
              <span className="block text-xs text-gray-500">
                Display the video description on the watch page.
              </span>
            </span>
            <button
              role="switch"
              aria-checked={settings.showDescription}
              onClick={() => update({ showDescription: !settings.showDescription })}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                settings.showDescription ? "bg-accent" : "bg-ink-700"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                  settings.showDescription ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
        </div>

        <div className="border-t border-ink-700 pt-6">
          <h2 className="mb-1 text-sm font-medium text-gray-200">Subtitles</h2>
          <p className="mb-3 text-xs text-gray-500">
            Caption size and how far they sit above the player controls.
          </p>
          <div className="mb-4 flex flex-wrap gap-2">
            {SUBTITLE_SIZES.map((opt) => (
              <button
                key={opt.value}
                onClick={() => update({ subtitleSize: opt.value })}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  settings.subtitleSize === opt.value
                    ? "bg-accent text-ink-950"
                    : "bg-ink-800 text-gray-300 hover:bg-ink-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <label className="block text-xs text-gray-500">
            Vertical position: {settings.subtitleOffset}
          </label>
          <input
            type="range"
            min={0}
            max={40}
            step={1}
            value={settings.subtitleOffset}
            onChange={(e) => update({ subtitleOffset: Number(e.target.value) })}
            className="accent-scrubber mt-2 w-full"
          />
        </div>

        <div className="border-t border-ink-700 pt-6">
          <h2 className="mb-1 text-sm font-medium text-gray-200">
            Default playback speed
          </h2>
          <p className="mb-3 text-xs text-gray-500">
            Speed a video starts at. Hold-click the video for a temporary 2x.
          </p>
          <div className="flex flex-wrap gap-2">
            {SPEED_STEPS.map((s) => (
              <button
                key={s}
                onClick={() => update({ defaultPlaybackRate: s })}
                className={`rounded-lg px-3 py-2 text-sm font-medium tabular-nums transition-colors ${
                  settings.defaultPlaybackRate === s
                    ? "bg-accent text-ink-950"
                    : "bg-ink-800 text-gray-300 hover:bg-ink-700"
                }`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-ink-700 pt-6">
          <h2 className="mb-1 text-sm font-medium text-gray-200">Storage</h2>
          <p className="mb-3 text-xs text-gray-500">
            Total space used by your library on disk.
          </p>
          {storage ? (
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-bold text-gray-100">
                {formatSize(storage.total_bytes) || "0 B"}
              </span>
              <span className="text-xs text-gray-500">
                {storage.video_count} video
                {storage.video_count === 1 ? "" : "s"}
              </span>
            </div>
          ) : (
            <p className="text-sm text-gray-500">Calculating...</p>
          )}
        </div>
      </div>
    </div>
  );
}
