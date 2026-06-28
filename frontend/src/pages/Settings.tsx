import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import {
  useSettings,
  type ChannelSort,
  type LibrarySort,
  type SubtitleSize,
  type Theme,
} from "../hooks/useSettings";
import { LIBRARY_SORT_OPTIONS } from "../hooks/useLibrarySort";
import type { AppSettings, HealthStats, StorageStats } from "../types";
import { formatSize } from "../utils";

const SUBTITLE_SIZES: { value: SubtitleSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

const CHANNEL_SORT_OPTIONS: { value: ChannelSort; label: string }[] = [
  { value: "recent_download", label: "Recent download" },
  { value: "video_count", label: "Video count" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "subscriber_count", label: "Subscriber count" },
];

const THEMES: { value: Theme; label: string; preview: string }[] = [
  { value: "default", label: "Default (cyan)", preview: "#22d3ee" },
  { value: "oled", label: "OLED (true black)", preview: "#22d3ee" },
  { value: "terminal", label: "Terminal (green)", preview: "#4ade80" },
  { value: "nord", label: "Nord", preview: "#88c0d0" },
  { value: "light", label: "Light & Clean", preview: "#cc0000" },
  { value: "indigo", label: "Midnight Indigo", preview: "#6366f1" },
  { value: "cyber", label: "Neon Cyber", preview: "#00f5ff" },
  { value: "sunset", label: "Warm Sunset", preview: "#ff6b35" },
  { value: "forest", label: "Forest Deep", preview: "#22c55e" },
  { value: "slate", label: "Slate Minimal", preview: "#60a5fa" },
  { value: "custom", label: "Custom", preview: "#22d3ee" },
];

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${
        checked ? "bg-accent" : "bg-ink-700"
      }`}
    >
      <span
        className={`block h-5 w-5 rounded-full bg-white transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control: React.ReactNode;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span>
        <span className="block text-sm font-medium text-gray-200">{title}</span>
        {description && (
          <span className="block text-xs text-gray-500">{description}</span>
        )}
      </span>
      {control}
    </label>
  );
}

export default function Settings() {
  const [settings, update] = useSettings();
  const { showToast } = useToast();
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [health, setHealth] = useState<HealthStats | null>(null);
  const [expiryInput, setExpiryInput] = useState<string>("");
  const [metadataSyncing, setMetadataSyncing] = useState(false);

  useEffect(() => {
    api.storageStats().then(setStorage).catch(() => undefined);
    api
      .getAppSettings()
      .then((s) => {
        setAppSettings(s);
        setExpiryInput(String(s.progress_expiry_days));
      })
      .catch(() => undefined);
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => undefined);
  }, []);

  const saveExpiry = async () => {
    const days = parseInt(expiryInput, 10);
    if (isNaN(days) || days < 1 || days > 365) return;
    const updated = await api
      .updateAppSettings({ progress_expiry_days: days })
      .catch(() => null);
    if (updated) {
      setAppSettings(updated);
      update({ progressExpiryDays: updated.progress_expiry_days });
    }
  };

  const resyncAllMetadata = async () => {
    if (metadataSyncing) return;
    if (
      !confirm(
        "Resync metadata for all videos with a source URL? This fetches thumbnails, captions, view counts, and channel stats."
      )
    ) {
      return;
    }
    setMetadataSyncing(true);
    const result = await api.refreshMetadataBulk().catch(() => null);
    setMetadataSyncing(false);
    if (!result) {
      showToast("Metadata sync failed");
      return;
    }
    showToast(
      `Synced ${result.refreshed} video${result.refreshed === 1 ? "" : "s"}` +
        (result.failed ? ` (${result.failed} failed)` : "") +
        (result.skipped ? ` (${result.skipped} skipped)` : "")
    );
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Settings</h1>
      <p className="mb-6 text-sm text-gray-400">
        Preferences are stored in this browser.
      </p>

      <div className="space-y-6 rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700">

        {/* ── Theme ── */}
        <div>
          <h2 className="mb-1 text-sm font-medium text-gray-200">Theme</h2>
          <p className="mb-3 text-xs text-gray-500">Choose a color palette.</p>
          <select
            value={settings.theme}
            onChange={(e) => update({ theme: e.target.value as Theme })}
            className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
          >
            {THEMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>

          {settings.theme === "custom" && (
            <div className="mt-4 space-y-3 rounded-lg border border-ink-700 bg-ink-950 p-4">
              <p className="text-xs text-gray-500">
                Pick your own accent and background. Surface colors are derived
                automatically.
              </p>
              <label className="flex items-center justify-between gap-4">
                <span className="text-sm text-gray-300">Accent</span>
                <input
                  type="color"
                  value={settings.customColors.accent}
                  onChange={(e) =>
                    update({
                      customColors: {
                        ...settings.customColors,
                        accent: e.target.value,
                      },
                    })
                  }
                  className="h-9 w-14 cursor-pointer rounded border border-ink-700 bg-transparent p-0.5"
                />
              </label>
              <label className="flex items-center justify-between gap-4">
                <span className="text-sm text-gray-300">Background</span>
                <input
                  type="color"
                  value={settings.customColors.background}
                  onChange={(e) =>
                    update({
                      customColors: {
                        ...settings.customColors,
                        background: e.target.value,
                      },
                    })
                  }
                  className="h-9 w-14 cursor-pointer rounded border border-ink-700 bg-transparent p-0.5"
                />
              </label>
              <div className="flex items-center gap-2 pt-1">
                <span
                  className="h-6 flex-1 rounded-md ring-1 ring-ink-700"
                  style={{ backgroundColor: settings.customColors.background }}
                />
                <span
                  className="h-6 w-16 rounded-md ring-1 ring-ink-700"
                  style={{ backgroundColor: settings.customColors.accent }}
                />
              </div>
            </div>
          )}
        </div>

        {/* ── Library metadata ── */}
        <div className="border-t border-ink-700 pt-6">
          <h2 className="mb-1 text-sm font-medium text-gray-200">
            Library metadata
          </h2>
          <p className="mb-3 text-xs text-gray-500">
            Pull fresh thumbnails, captions, view counts, and channel subscriber
            counts from each video&apos;s source URL.
          </p>
          <button
            onClick={resyncAllMetadata}
            disabled={metadataSyncing}
            className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {metadataSyncing ? "Syncing…" : "Resync all metadata"}
          </button>
        </div>

        {/* ── Description ── */}
        <div className="border-t border-ink-700 pt-6">
          <SettingRow
            title="Show description"
            description="Display the video description on the watch page."
            control={
              <Toggle
                checked={settings.showDescription}
                onChange={() =>
                  update({ showDescription: !settings.showDescription })
                }
              />
            }
          />
        </div>

        {/* ── Library ── */}
        <div className="border-t border-ink-700 pt-6">
          <h2 className="mb-1 text-sm font-medium text-gray-200">Library</h2>
          <p className="mb-4 text-xs text-gray-500">
            Homepage and channel sidebar preferences.
          </p>

          <div className="mb-6 space-y-4">
            <SettingRow
              title="Show continue watching"
              description="Display the continue watching row on the library home page."
              control={
                <Toggle
                  checked={settings.showContinueWatching}
                  onChange={() =>
                    update({
                      showContinueWatching: !settings.showContinueWatching,
                    })
                  }
                />
              }
            />
            <SettingRow
              title="Progress bar on continue watching"
              description="Show watch progress on cards in the continue watching row."
              control={
                <Toggle
                  checked={settings.showProgressOnContinueWatching}
                  onChange={() =>
                    update({
                      showProgressOnContinueWatching:
                        !settings.showProgressOnContinueWatching,
                    })
                  }
                />
              }
            />
            <SettingRow
              title="Progress bar on all library videos"
              description="Show watch progress on every card in the main library grid."
              control={
                <Toggle
                  checked={settings.showProgressOnAllVideos}
                  onChange={() =>
                    update({
                      showProgressOnAllVideos: !settings.showProgressOnAllVideos,
                    })
                  }
                />
              }
            />
          </div>

          <div className="mb-6">
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Progress bar expiry (days)
            </label>
            <p className="mb-2 text-xs text-gray-500">
              Watch position resets after this many days of inactivity.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={365}
                value={expiryInput}
                onChange={(e) => setExpiryInput(e.target.value)}
                className="w-24 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
              />
              <button
                onClick={saveExpiry}
                disabled={
                  !appSettings ||
                  parseInt(expiryInput, 10) ===
                    appSettings.progress_expiry_days
                }
                className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>

          <p className="mb-2 text-xs font-medium text-gray-400">
            Default video sort
          </p>
          <p className="mb-3 text-xs text-gray-500">
            Used when you open the library or after a temporary sort expires (3
            hours).
          </p>
          <div className="mb-6 flex flex-wrap gap-2">
            {LIBRARY_SORT_OPTIONS.filter((o) => o.value !== "random").map(
              (opt) => (
                <button
                  key={opt.value}
                  onClick={() =>
                    update({ defaultLibrarySort: opt.value as LibrarySort })
                  }
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    settings.defaultLibrarySort === opt.value
                      ? "bg-accent text-ink-950"
                      : "bg-ink-800 text-gray-300 hover:bg-ink-700"
                  }`}
                >
                  {opt.label}
                </button>
              )
            )}
          </div>

          <p className="mb-2 text-xs font-medium text-gray-400">
            Channel List Order (Sidebar)
          </p>
          <div className="mb-3 flex flex-wrap gap-2">
            {CHANNEL_SORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => update({ channelSort: opt.value })}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  settings.channelSort === opt.value
                    ? "bg-accent text-ink-950"
                    : "bg-ink-800 text-gray-300 hover:bg-ink-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            {(["desc", "asc"] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => update({ channelOrder: dir })}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  settings.channelOrder === dir
                    ? "bg-accent text-ink-950"
                    : "bg-ink-800 text-gray-300 hover:bg-ink-700"
                }`}
              >
                {dir === "desc" ? "Descending" : "Ascending"}
              </button>
            ))}
          </div>
        </div>

        {/* ── Downloads ── */}
        <div className="border-t border-ink-700 pt-6">
          <h2 className="mb-1 text-sm font-medium text-gray-200">Downloads</h2>
          <p className="mb-4 text-xs text-gray-500">
            Background download queue and navigation preferences.
          </p>
          <div className="space-y-4">
            <SettingRow
              title="Show download count in navigation"
              description="Badge on the Download tab while jobs are queued or in progress."
              control={
                <Toggle
                  checked={settings.showDownloadNavBadge}
                  onChange={() =>
                    update({
                      showDownloadNavBadge: !settings.showDownloadNavBadge,
                    })
                  }
                />
              }
            />
            <SettingRow
              title="Normalize volume on download"
              description="Apply loudness normalization when saving new videos (requires ffmpeg)."
              control={
                <Toggle
                  checked={settings.normalizeVolumeOnDownload}
                  onChange={() =>
                    update({
                      normalizeVolumeOnDownload:
                        !settings.normalizeVolumeOnDownload,
                    })
                  }
                />
              }
            />
          </div>
        </div>

        {/* ── Subtitles ── */}
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

        {/* ── SponsorBlock ── */}
        <div className="border-t border-ink-700 pt-6">
          <h2 className="mb-1 text-sm font-medium text-gray-200">
            SponsorBlock
          </h2>
          <p className="mb-4 text-xs text-gray-500">
            Automatically skip sponsored segments and other non-content during
            playback of YouTube videos.
          </p>
          <div className="space-y-4">
            <SettingRow
              title="Enable SponsorBlock"
              description="Skip sponsors, self-promotion, and intros automatically."
              control={
                <Toggle
                  checked={settings.sponsorBlockEnabled}
                  onChange={() =>
                    update({
                      sponsorBlockEnabled: !settings.sponsorBlockEnabled,
                    })
                  }
                />
              }
            />
            {settings.sponsorBlockEnabled && (
              <SettingRow
                title="Show skip notice"
                description="Brief on-screen notification when a segment is skipped."
                control={
                  <Toggle
                    checked={settings.sponsorBlockShowNotice}
                    onChange={() =>
                      update({
                        sponsorBlockShowNotice:
                          !settings.sponsorBlockShowNotice,
                      })
                    }
                  />
                }
              />
            )}
          </div>
        </div>

        {/* ── Default playback speed ── */}
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

        {/* ── Storage ── */}
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

        {/* ── Health ── */}
        <div className="border-t border-ink-700 pt-6">
          <h2 className="mb-1 text-sm font-medium text-gray-200">Health</h2>
          <p className="mb-3 text-xs text-gray-500">System status overview.</p>
          {health ? (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-400">yt-dlp</dt>
                <dd className="font-mono text-gray-200">{health.yt_dlp_version}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-400">Library</dt>
                <dd className="text-gray-200">{health.library_video_count} videos</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-400">Needs review</dt>
                <dd className="text-gray-200">{health.review_pending_count}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-400">Active downloads</dt>
                <dd className="text-gray-200">{health.active_downloads}</dd>
              </div>
              {health.disk && (
                <div className="flex justify-between">
                  <dt className="text-gray-400">Disk free</dt>
                  <dd className="text-gray-200">
                    {formatSize(health.disk.free_bytes)} /{" "}
                    {formatSize(health.disk.total_bytes)}
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-gray-500">Loading...</p>
          )}
        </div>
      </div>
    </div>
  );
}
