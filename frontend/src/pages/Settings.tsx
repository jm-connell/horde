import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import {
  useSettings,
  type BackgroundEffect,
  type ChannelSort,
  type HoverMotion,
  type LibrarySort,
  type NavIndicator,
  type SubtitleSize,
  type Theme,
} from "../hooks/useSettings";
import { BACKGROUND_EFFECT_OPTIONS } from "../effects";
import { LIBRARY_SORT_OPTIONS } from "../hooks/useLibrarySort";
import type { AppSettings, HealthStats, StorageStats } from "../types";
import { formatSize } from "../utils";
import LiquidNav from "../components/LiquidNav";
import Collapse from "../components/Collapse";
import LoadingIndicator from "../components/LoadingIndicator";

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

type SettingsTab =
  | "appearance"
  | "library"
  | "playback"
  | "downloads"
  | "system";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "library", label: "Library" },
  { id: "playback", label: "Playback" },
  { id: "downloads", label: "Downloads" },
  { id: "system", label: "System" },
];

const HOVER_MOTION_OPTIONS: {
  value: HoverMotion;
  label: string;
  description: string;
}[] = [
  { value: "off", label: "Off", description: "No hover motion" },
  {
    value: "subtle",
    label: "Subtle",
    description: "Light lift and brightness on hover",
  },
  {
    value: "lift",
    label: "Lift",
    description: "Cards rise with a soft shadow",
  },
  {
    value: "glow",
    label: "Glow",
    description: "Accent glow around hovered surfaces",
  },
];

const NAV_INDICATOR_OPTIONS: {
  value: NavIndicator;
  label: string;
  description: string;
}[] = [
  { value: "none", label: "None", description: "Static active state only" },
  {
    value: "liquid",
    label: "Liquid",
    description: "Jelly pill that morphs between items",
  },
  {
    value: "underline",
    label: "Underline",
    description: "Sliding accent bar under the active item",
  },
  {
    value: "fade",
    label: "Fade",
    description: "Soft pill that eases between items",
  },
];

const TAB_STORAGE_KEY = "horde.settings.tab";

function loadTab(): SettingsTab {
  try {
    const raw = localStorage.getItem(TAB_STORAGE_KEY);
    if (TABS.some((t) => t.id === raw)) return raw as SettingsTab;
  } catch {
    /* ignore */
  }
  return "appearance";
}

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
      className={`ui-interactive flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${
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

function Section({
  title,
  description,
  children,
  first = false,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  first?: boolean;
}) {
  return (
    <div className={first ? undefined : "border-t border-ink-700 pt-6"}>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
        {title}
      </h2>
      {description && (
        <p className="mb-3 text-xs text-gray-500">{description}</p>
      )}
      <div className={description ? undefined : "mt-3"}>{children}</div>
    </div>
  );
}

export default function Settings() {
  const [settings, update] = useSettings();
  const { showToast } = useToast();
  const [tab, setTab] = useState<SettingsTab>(loadTab);
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

  const selectTab = (next: SettingsTab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  };

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
      <h1 className="mb-6 text-2xl font-bold text-gray-100">Settings</h1>

      <LiquidNav
        className="ui-panel mb-4 flex gap-1 overflow-x-auto rounded-xl bg-ink-900 p-1 ring-1 ring-ink-700"
        pillClassName="bg-ink-800"
        dependency={tab}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            data-liquid-active={tab === t.id ? "true" : undefined}
            onClick={() => selectTab(t.id)}
            className={`ui-interactive relative z-10 shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? settings.navIndicator !== "none"
                  ? "text-gray-100"
                  : "bg-ink-800 text-gray-100"
                : "text-gray-400 hover:text-gray-200"
            } ${
              settings.navIndicator === "none" && tab !== t.id
                ? "hover:bg-ink-800/60"
                : ""
            }`}
          >
            {t.label}
          </button>
        ))}
      </LiquidNav>

      <div
        role="tabpanel"
        className="ui-panel space-y-6 rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700"
      >
        {tab === "appearance" && (
          <>
            <Section
              first
              title="Theme"
              description="Choose a color palette for the app chrome."
            >
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

              <Collapse open={settings.theme === "custom"}>
                <div className="mt-4 space-y-3 rounded-lg border border-ink-700 bg-ink-950 p-4">
                  <p className="text-xs text-gray-500">
                    Pick your own accent and background. Surface colors are
                    derived automatically.
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
                      style={{
                        backgroundColor: settings.customColors.background,
                      }}
                    />
                    <span
                      className="h-6 w-16 rounded-md ring-1 ring-ink-700"
                      style={{
                        backgroundColor: settings.customColors.accent,
                      }}
                    />
                  </div>
                </div>
              </Collapse>
            </Section>

            <Section
              title="Background animation"
              description="Optional atmospheric effects behind the UI. Disabled automatically when the system prefers reduced motion."
            >
              <select
                value={settings.backgroundEffect}
                onChange={(e) =>
                  update({
                    backgroundEffect: e.target.value as BackgroundEffect,
                  })
                }
                className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
              >
                {BACKGROUND_EFFECT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <Collapse open={settings.backgroundEffect !== "none"}>
                <p className="mt-2 text-xs text-gray-500">
                  {
                    BACKGROUND_EFFECT_OPTIONS.find(
                      (o) => o.value === settings.backgroundEffect
                    )?.description
                  }
                </p>
              </Collapse>

              <Collapse open={settings.backgroundEffect !== "none"}>
                <div className="mt-4 space-y-4">
                  <label className="block">
                    <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                      <span>Intensity</span>
                      <span className="tabular-nums text-gray-500">
                        {Math.round(settings.backgroundOpacity * 100)}%
                      </span>
                    </span>
                    <input
                      type="range"
                      min={0.1}
                      max={1}
                      step={0.05}
                      value={settings.backgroundOpacity}
                      onChange={(e) =>
                        update({ backgroundOpacity: Number(e.target.value) })
                      }
                      className="accent-scrubber w-full"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                      <span>Speed</span>
                      <span className="tabular-nums text-gray-500">
                        {settings.backgroundEffectSpeed.toFixed(2)}x
                      </span>
                    </span>
                    <input
                      type="range"
                      min={0.25}
                      max={3}
                      step={0.05}
                      value={settings.backgroundEffectSpeed}
                      onChange={(e) =>
                        update({
                          backgroundEffectSpeed: Number(e.target.value),
                        })
                      }
                      className="accent-scrubber w-full"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                      <span>Size</span>
                      <span className="tabular-nums text-gray-500">
                        {settings.backgroundEffectSize.toFixed(2)}x
                      </span>
                    </span>
                    <input
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.05}
                      value={settings.backgroundEffectSize}
                      onChange={(e) =>
                        update({
                          backgroundEffectSize: Number(e.target.value),
                        })
                      }
                      className="accent-scrubber w-full"
                    />
                  </label>

                  <div>
                    <p className="mb-2 text-sm text-gray-300">Color</p>
                    <div className="mb-3 flex flex-wrap gap-2">
                      {(
                        [
                          { value: "accent", label: "Match theme accent" },
                          { value: "custom", label: "Custom" },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() =>
                            update({ backgroundEffectColorMode: opt.value })
                          }
                          className={`ui-interactive rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                            settings.backgroundEffectColorMode === opt.value
                              ? "bg-accent text-ink-950"
                              : "bg-ink-800 text-gray-300 hover:bg-ink-700"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    {settings.backgroundEffectColorMode === "custom" && (
                      <label className="flex items-center justify-between gap-4 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2">
                        <span className="text-sm text-gray-300">
                          Effect color
                        </span>
                        <input
                          type="color"
                          value={settings.backgroundEffectColor}
                          onChange={(e) =>
                            update({ backgroundEffectColor: e.target.value })
                          }
                          className="h-9 w-14 cursor-pointer rounded border border-ink-700 bg-transparent p-0.5"
                        />
                      </label>
                    )}
                  </div>

                  <SettingRow
                    title="Pause while watching"
                    description="Stop the animation on the watch page to save GPU."
                    control={
                      <Toggle
                        checked={settings.pauseBackgroundWhileWatching}
                        onChange={() =>
                          update({
                            pauseBackgroundWhileWatching:
                              !settings.pauseBackgroundWhileWatching,
                          })
                        }
                      />
                    }
                  />
                </div>
              </Collapse>
            </Section>

            <Section
              title="Interface motion"
              description="Hover and navigation transitions. Button press and page fade are always on. Automatically reduced when the system prefers reduced motion."
            >
              <div className="space-y-5">
                <div>
                  <p className="mb-2 text-sm font-medium text-gray-200">
                    Navigation indicator
                  </p>
                  <p className="mb-3 text-xs text-gray-500">
                    How the active nav item and settings tabs are highlighted.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {NAV_INDICATOR_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => update({ navIndicator: opt.value })}
                        className={`ui-interactive rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                          settings.navIndicator === opt.value
                            ? "bg-accent text-ink-950"
                            : "bg-ink-800 text-gray-300 hover:bg-ink-700"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    {
                      NAV_INDICATOR_OPTIONS.find(
                        (o) => o.value === settings.navIndicator
                      )?.description
                    }
                  </p>
                </div>

                <div>
                  <p className="mb-2 text-sm font-medium text-gray-200">
                    Hover motion
                  </p>
                  <p className="mb-3 text-xs text-gray-500">
                    How cards and controls react when you hover them.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {HOVER_MOTION_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => update({ hoverMotion: opt.value })}
                        className={`ui-interactive rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                          settings.hoverMotion === opt.value
                            ? "bg-accent text-ink-950"
                            : "bg-ink-800 text-gray-300 hover:bg-ink-700"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    {
                      HOVER_MOTION_OPTIONS.find(
                        (o) => o.value === settings.hoverMotion
                      )?.description
                    }
                  </p>
                </div>

                <SettingRow
                  title="Translucent panels"
                  description="Let background animations show through nav, cards, and settings panels."
                  control={
                    <Toggle
                      checked={settings.translucentPanels}
                      onChange={() =>
                        update({
                          translucentPanels: !settings.translucentPanels,
                        })
                      }
                    />
                  }
                />
                <Collapse open={settings.translucentPanels}>
                  <label className="mt-1 block">
                    <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                      <span>Panel transparency</span>
                      <span className="tabular-nums text-gray-500">
                        {Math.round(settings.translucentPanelStrength * 100)}%
                      </span>
                    </span>
                    <input
                      type="range"
                      min={0.15}
                      max={1}
                      step={0.05}
                      value={settings.translucentPanelStrength}
                      onChange={(e) =>
                        update({
                          translucentPanelStrength: Number(e.target.value),
                        })
                      }
                      className="accent-scrubber w-full"
                    />
                    <p className="mt-2 text-xs text-gray-500">
                      Higher values make panels more see-through so effects stay
                      visible. Turn intensity up on the background animation if
                      needed.
                    </p>
                  </label>
                </Collapse>

                <div>
                  <span className="mb-2 block text-sm font-medium text-gray-200">
                    Loading animation
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        { value: "dots", label: "Dots" },
                        { value: "spinner", label: "Spinner" },
                        { value: "bar", label: "Bar" },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => update({ loadingStyle: opt.value })}
                        className={`rounded-lg px-3 py-1.5 text-sm ${
                          settings.loadingStyle === opt.value
                            ? "bg-accent text-ink-950"
                            : "bg-ink-800 text-gray-300 hover:bg-ink-700"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    Style used for page and list loading states.
                  </p>
                </div>
              </div>
            </Section>
          </>
        )}

        {tab === "library" && (
          <>
            <Section
              first
              title="Library metadata"
              description="Pull fresh thumbnails, captions, view counts, and channel subscriber counts from each video's source URL."
            >
              <button
                onClick={resyncAllMetadata}
                disabled={metadataSyncing}
                className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {metadataSyncing ? "Syncing…" : "Resync all metadata"}
              </button>
            </Section>

            <Section
              title="Homepage"
              description="Homepage and continue watching preferences."
            >
              <div className="space-y-4">
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
                          showProgressOnAllVideos:
                            !settings.showProgressOnAllVideos,
                        })
                      }
                    />
                  }
                />
                <SettingRow
                  title="Show dates on video cards"
                  description="Display the published date (e.g. May 14, 2023) on library cards."
                  control={
                    <Toggle
                      checked={settings.showCardDates}
                      onChange={() =>
                        update({ showCardDates: !settings.showCardDates })
                      }
                    />
                  }
                />
              </div>
            </Section>

            <Section
              title="Progress expiry"
              description="Saved watch position resets after this many days of inactivity. The continue watching row hides videos after 7 days."
            >
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
            </Section>

            <Section
              title="Default video sort"
              description="Used when you open the library or after a temporary sort expires (3 hours)."
            >
              <div className="flex flex-wrap gap-2">
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
            </Section>

            <Section title="Channel list order (sidebar)">
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
            </Section>
          </>
        )}

        {tab === "playback" && (
          <>
            <Section
              first
              title="Watch page"
              description="Layout options on the video watch page."
            >
              <div className="space-y-4">
                <SettingRow
                  title="Show description"
                  description="Display the video description on the watch page."
                  control={
                    <Toggle
                      checked={settings.showDescription}
                      onChange={() =>
                        update({
                          showDescription: !settings.showDescription,
                        })
                      }
                    />
                  }
                />
                <SettingRow
                  title="Show related videos sidebar"
                  description="On desktop in normal view, show recommended videos in a column to the right of the player."
                  control={
                    <Toggle
                      checked={settings.showRelatedVideos}
                      onChange={() =>
                        update({
                          showRelatedVideos: !settings.showRelatedVideos,
                        })
                      }
                    />
                  }
                />
              </div>
            </Section>

            <Section
              title="Subtitles"
              description="Caption size and how far they sit above the player controls."
            >
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
                onChange={(e) =>
                  update({ subtitleOffset: Number(e.target.value) })
                }
                className="accent-scrubber mt-2 w-full"
              />
            </Section>

            <Section
              title="SponsorBlock"
              description="Automatically skip sponsored segments and other non-content during playback of YouTube videos."
            >
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
            </Section>

            <Section
              title="Default playback speed"
              description="Speed a video starts at. Hold-click the video for a temporary 2x."
            >
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
            </Section>
          </>
        )}

        {tab === "downloads" && (
          <Section
            first
            title="Downloads"
            description="Background download queue and navigation preferences."
          >
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
          </Section>
        )}

        {tab === "system" && (
          <>
            <Section
              first
              title="Storage"
              description="Total space used by your library on disk."
            >
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
            </Section>

            <Section title="Health" description="System status overview.">
              {health ? (
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-400">yt-dlp</dt>
                    <dd className="font-mono text-gray-200">
                      {health.yt_dlp_version}
                    </dd>
                  </div>
                  {health.pot_provider && (
                    <div className="flex justify-between">
                      <dt className="text-gray-400">PO token provider</dt>
                      <dd className="text-gray-200">
                        {health.pot_provider.status === "ok" ? (
                          <>
                            Connected
                            {health.pot_provider.version
                              ? ` (v${health.pot_provider.version})`
                              : ""}
                          </>
                        ) : (
                          <span className="text-red-400">
                            {health.pot_provider.detail ?? "Unavailable"}
                          </span>
                        )}
                      </dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt className="text-gray-400">Library</dt>
                    <dd className="text-gray-200">
                      {health.library_video_count} videos
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-400">Needs review</dt>
                    <dd className="text-gray-200">
                      {health.review_pending_count}
                    </dd>
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
                <LoadingIndicator label="Loading" className="py-4" />
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
