import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import {
  useSettings,
  loadSettings,
  type BackgroundEffect,
  type ChannelSort,
  type CustomThemePreset,
  type FlowingGradientPreset,
  type HoverMotion,
  type LibrarySort,
  type NavIndicator,
  type SubtitleSize,
  type Theme,
  type FontSize,
  type UiFont,
} from "../hooks/useSettings";
import {
  fontSelectOptions,
  labelFromFilename,
  newCustomFontId,
  parseCustomFontInput,
} from "../fonts";
import {
  BACKGROUND_EFFECT_OPTIONS,
  FLOWING_PRESET_OPTIONS,
} from "../effects";
import { LIBRARY_SORT_OPTIONS } from "../hooks/useLibrarySort";
import type {
  AiCurrentJob,
  AiSchedule,
  AiSettings,
  AiStatus,
  AppSettings,
  HealthStats,
  StorageStats,
  SystemStats,
} from "../types";
import { formatSize } from "../utils";
import LiquidNav from "../components/LiquidNav";
import ThemedSelect from "../components/ThemedSelect";
import Collapse from "../components/Collapse";
import LoadingIndicator from "../components/LoadingIndicator";
import HelpTip from "../components/HelpTip";

const CHIP =
  "ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm font-medium text-gray-300 transition-colors hover:border-accent hover:text-gray-100";
const CHIP_ACTIVE =
  "ui-panel ui-interactive rounded-lg border border-accent/50 bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition-colors";
const PANEL_BTN =
  "ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-200 hover:border-accent disabled:cursor-not-allowed disabled:opacity-50";
const INPUT =
  "ui-panel w-full max-w-md rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent";
const PROCESS_BTN =
  "ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50";

const FONT_SIZE_OPTIONS: { value: FontSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "xl", label: "XL" },
];

const AI_PROCESS_PRIMARY: {
  action: "all_recent" | "all_full";
  label: string;
  title: string;
}[] = [
  {
    action: "all_recent",
    label: "Run all (recent)",
    title:
      "Queue missing search indexes and AI tags for videos watched or added in the last 30 days, then refresh categories.",
  },
  {
    action: "all_full",
    label: "Run all (full library)",
    title:
      "Queue missing search indexes and AI tags across the whole library, then refresh categories.",
  },
];

const AI_PROCESS_SECONDARY: {
  action: "embeds" | "missing_tags" | "full_tags" | "categories";
  label: string;
  title: string;
}[] = [
  {
    action: "embeds",
    label: "Index missing videos for search",
    title:
      "Build search indexes for videos that are not indexed yet, or whose indexes use a different embed model (used for semantic search, related videos, and category shelves).",
  },
  {
    action: "missing_tags",
    label: "Enrich missing AI tags",
    title: "Ask the chat model to suggest tags only for videos missing AI tags.",
  },
  {
    action: "full_tags",
    label: "Full tag refresh",
    title: "Re-run AI tag enrichment for every video in the library.",
  },
  {
    action: "categories",
    label: "Refresh categories",
    title:
      "Ask the chat model to invent specific browse categories from a diverse sample " +
      "(title, channel, tags, description, subtitle excerpt), then match videos via " +
      "search indexes. Refresh after re-indexing if you changed the embed model.",
  },
];

const EMBED_MODEL_TIP =
  "Search index model — used for semantic search, related videos, and filling category shelves. Much lighter on VRAM than chat (typically ~0.5–1GB). nomic-embed-text is a solid default; mxbai-embed-large is higher quality for category matching but heavier; all-minilm is the lightest. Changing this requires re-indexing the library.";
const CHAT_MODEL_TIP =
  "Chat model — invents recommendation category chips, enriches tags, and scores duplicates. Needs more VRAM than search indexes: 1B ≈ 1–2GB, 3B-class ≈ 3–6GB. Prefer smaller models on 6GB GPUs; qwen2.5:3b or a larger custom model can invent more specific categories.";

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

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
  { value: "light", label: "Minimal Neutrals + Teal (light)", preview: "#14b8a6" },
  { value: "indigo", label: "Midnight Indigo", preview: "#6366f1" },
  { value: "cyber", label: "Neon Cyber", preview: "#00f5ff" },
  { value: "sunset", label: "Warm Sunset", preview: "#ff6b35" },
  { value: "forest", label: "Forest Deep", preview: "#22c55e" },
  { value: "slate", label: "Slate Minimal", preview: "#60a5fa" },
  { value: "earthy", label: "Earthy Modern (light)", preview: "#854d0e" },
  { value: "frozen", label: "Frozen Blue Minimal (light)", preview: "#0ea5e9" },
  { value: "mocha", label: "Soft Mocha & Sage (light)", preview: "#a78bfa" },
  { value: "custom", label: "Custom", preview: "#22d3ee" },
];

type SettingsTab =
  | "appearance"
  | "library"
  | "playback"
  | "downloads"
  | "ai"
  | "system";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "library", label: "Library" },
  { id: "playback", label: "Playback" },
  { id: "downloads", label: "Downloads" },
  { id: "ai", label: "AI" },
  { id: "system", label: "System" },
];

const AI_SCHEDULE_OPTIONS: { value: AiSchedule; label: string; description: string }[] = [
  {
    value: "on_download",
    label: "On download",
    description: "Embed and enrich tags when a video finishes downloading",
  },
  {
    value: "timer",
    label: "Timer",
    description: "Periodically index videos missing search indexes",
  },
  {
    value: "set_time",
    label: "Set time",
    description: "Run once per day at a chosen local clock time",
  },
  {
    value: "on_request",
    label: "When requested",
    description: "No automatic work — use the process actions below",
  },
];

const EMBED_MODEL_OPTIONS = [
  { value: "nomic-embed-text", label: "nomic-embed-text (default)" },
  { value: "mxbai-embed-large", label: "mxbai-embed-large" },
  { value: "all-minilm", label: "all-minilm" },
  { value: "__custom__", label: "Custom…" },
];

const CHAT_MODEL_OPTIONS = [
  { value: "llama3.2:3b", label: "llama3.2:3b (default)" },
  { value: "llama3.2:1b", label: "llama3.2:1b" },
  { value: "qwen2.5:3b", label: "qwen2.5:3b" },
  { value: "phi3:mini", label: "phi3:mini" },
  { value: "__custom__", label: "Custom…" },
];

const DEFAULT_AI: AiSettings = {
  enabled: true,
  provider: "ollama",
  base_url: "",
  embed_model: "nomic-embed-text",
  chat_model: "llama3.2:3b",
  schedule: "on_download",
  timer_hours: 6,
  schedule_time: "03:00",
  auto_pull_models: true,
  use_subtitles: true,
  enrich_tags: true,
  ai_duplicates: true,
  category_min_score: 0.55,
  paused: false,
};

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

/** Search keywords / synonyms → tab. Used for cross-tab search + auto-switch. */
const SEARCH_REGISTRY: { tab: SettingsTab; keywords: string }[] = [
  // Appearance
  { tab: "appearance", keywords: "theme color palette chrome custom" },
  {
    tab: "appearance",
    keywords:
      "font typeface typography google fonts jetbrains roboto ubuntu space grotesk ibm plex inconsolata oxanium source sans electrolize custom font upload font size small medium large xl text size",
  },
  {
    tab: "appearance",
    keywords:
      "interface motion navigation indicator nav liquid jelly underline fade glow lift hover motion cards controls translucent panels panel transparency legibility loading animation dots spinner bar",
  },
  {
    tab: "appearance",
    keywords:
      "saved themes save theme save current preset snapshot appearance",
  },
  {
    tab: "appearance",
    keywords:
      "background animation atmospheric effects intensity speed size color pause while watching custom image upload blur tint palette flowing rgb wave cool warm mono",
  },
  // Library
  {
    tab: "library",
    keywords:
      "library metadata resync thumbnails captions view counts",
  },
  {
    tab: "library",
    keywords:
      "homepage continue watching progress bar dates video cards",
  },
  {
    tab: "library",
    keywords: "progress expiry inactivity days",
  },
  {
    tab: "library",
    keywords: "default video sort sort library",
  },
  {
    tab: "library",
    keywords: "channel list order sidebar ascending descending",
  },
  // Playback
  {
    tab: "playback",
    keywords: "watch page description related videos autoplay sidebar",
  },
  {
    tab: "playback",
    keywords: "subtitles caption vertical position",
  },
  {
    tab: "playback",
    keywords: "sponsorblock sponsor skip ad ads advertising commercial",
  },
  {
    tab: "playback",
    keywords: "playback speed speed default",
  },
  // Downloads
  {
    tab: "downloads",
    keywords:
      "download count navigation badge normalize volume loudness downloads",
  },
  // AI
  {
    tab: "ai",
    keywords:
      "ollama connection enable ai base url queue indexed features gpu vram",
  },
  {
    tab: "ai",
    keywords:
      "models embedding chat model vram auto-pull gpu",
  },
  {
    tab: "ai",
    keywords:
      "when to run schedule process run all recent full embeds tags categories timer",
  },
  {
    tab: "ai",
    keywords: "features subtitles enrich tags duplicate confirmation llm category match strictness score",
  },
  // System
  {
    tab: "system",
    keywords: "storage disk space library",
  },
  {
    tab: "system",
    keywords:
      "health yt-dlp ollama disk import review downloads gpu system status",
  },
  {
    tab: "system",
    keywords: "resources cpu ram memory gpu vram temperature nvidia",
  },
];

function loadTab(): SettingsTab {
  try {
    const raw = localStorage.getItem(TAB_STORAGE_KEY);
    if (TABS.some((t) => t.id === raw)) return raw as SettingsTab;
  } catch {
    /* ignore */
  }
  return "appearance";
}

function matchesQuery(
  query: string,
  ...parts: (string | undefined | null)[]
): boolean {
  if (!query) return true;
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  if (hay.includes(query)) return true;
  // Also match when every query token appears in the haystack (order-independent).
  const tokens = query.split(/\s+/).filter(Boolean);
  return tokens.length > 1 && tokens.every((t) => hay.includes(t));
}

function tabMatchesQuery(tabId: SettingsTab, query: string): boolean {
  if (!query) return true;
  return SEARCH_REGISTRY.some(
    (entry) => entry.tab === tabId && matchesQuery(query, entry.keywords)
  );
}

function firstMatchingTab(query: string): SettingsTab | null {
  if (!query) return null;
  for (const t of TABS) {
    if (tabMatchesQuery(t.id, query)) return t.id;
  }
  return null;
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
  hidden = false,
}: {
  title: string;
  description?: string;
  control: React.ReactNode;
  hidden?: boolean;
}) {
  if (hidden) return null;
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
  hidden = false,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  first?: boolean;
  hidden?: boolean;
}) {
  if (hidden) return null;
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

function Chip({
  active,
  onClick,
  onPointerDown,
  children,
  className = "",
}: {
  active: boolean;
  onClick?: () => void;
  onPointerDown?: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={
        onPointerDown
          ? (e) => {
              e.preventDefault();
              onPointerDown();
            }
          : undefined
      }
      className={`${active ? CHIP_ACTIVE : CHIP} ${className}`}
    >
      {children}
    </button>
  );
}

function SystemStatsSnippet({ stats }: { stats: SystemStats | null }) {
  if (!stats) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  const cards: { label: string; value: React.ReactNode }[] = [];

  if (stats.cpu_model || stats.cpu_percent != null || stats.cpu_temp_c != null) {
    cards.push({
      label: "CPU",
      value: (
        <>
          {stats.cpu_model && (
            <span className="block text-xs text-gray-400">{stats.cpu_model}</span>
          )}
          <span className="block">
            {[
              stats.cpu_percent != null
                ? `${Math.round(stats.cpu_percent)}%`
                : null,
              stats.cpu_temp_c != null
                ? `${Math.round(stats.cpu_temp_c)}°C`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </>
      ),
    });
  }

  if (
    stats.ram_used_bytes != null &&
    stats.ram_total_bytes != null
  ) {
    cards.push({
      label: "RAM",
      value: (
        <>
          {formatSize(stats.ram_used_bytes)} / {formatSize(stats.ram_total_bytes)}
          {stats.ram_percent != null
            ? ` (${Math.round(stats.ram_percent)}%)`
            : ""}
        </>
      ),
    });
  } else if (stats.ram_percent != null) {
    cards.push({
      label: "RAM",
      value: `${Math.round(stats.ram_percent)}%`,
    });
  }

  if (stats.gpu) {
    const g = stats.gpu;
    const lines: string[] = [];
    if (g.util_percent != null) lines.push(`${Math.round(g.util_percent)}%`);
    if (g.temp_c != null) lines.push(`${Math.round(g.temp_c)}°C`);
    const vram =
      g.vram_used_bytes != null && g.vram_total_bytes != null
        ? `${formatSize(g.vram_used_bytes)} / ${formatSize(g.vram_total_bytes)}`
        : null;
    if (g.name || lines.length || vram) {
      cards.push({
        label: "GPU",
        value: (
          <>
            {g.name && (
              <span className="block text-xs text-gray-400">{g.name}</span>
            )}
            {lines.length > 0 && (
              <span className="block">{lines.join(" · ")}</span>
            )}
            {vram && (
              <span className="block text-xs text-gray-500">VRAM {vram}</span>
            )}
          </>
        ),
      });
    }
  }

  if (stats.disk) {
    cards.push({
      label: "Disk",
      value: (
        <>
          {formatSize(stats.disk.used_bytes)} /{" "}
          {formatSize(stats.disk.total_bytes)}
          <span className="block text-xs text-gray-500">
            {formatSize(stats.disk.free_bytes)} free
          </span>
        </>
      ),
    });
  }

  if (cards.length === 0) {
    return (
      <p className="text-sm text-gray-500">No resource stats available.</p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5"
        >
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {c.label}
          </p>
          <div className="text-sm text-gray-200">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function CurrentAiJob({ job }: { job: AiCurrentJob | string }) {
  if (typeof job === "string") {
    return (
      <div className="flex justify-between gap-3">
        <dt className="text-gray-400">Running</dt>
        <dd className="truncate text-right text-xs text-gray-300">{job}</dd>
      </div>
    );
  }

  const kindLabel = job.kind.replace(/_/g, " ");
  return (
    <div className="flex items-stretch justify-between gap-3">
      <dt className="shrink-0 pt-1 text-gray-400">Running</dt>
      <dd className="flex min-w-0 flex-1 items-start justify-end gap-3 text-right">
        <span className="min-w-0">
          <span className="block truncate text-xs text-gray-200">
            {job.title || (job.video_id == null ? kindLabel : "Untitled")}
          </span>
          <span className="block truncate text-[11px] text-gray-500">
            {[job.channel, kindLabel].filter(Boolean).join(" · ")}
          </span>
          {job.model && (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-gray-500">
              {job.model}
            </span>
          )}
        </span>
        {job.has_thumbnail && job.video_id != null ? (
          <img
            src={`/api/thumbnails/${job.video_id}`}
            alt=""
            className="aspect-video w-28 shrink-0 rounded object-cover ring-1 ring-ink-700"
          />
        ) : null}
      </dd>
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
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [aiDraft, setAiDraft] = useState<AiSettings>(DEFAULT_AI);
  const [aiTesting, setAiTesting] = useState(false);
  const [embedCustom, setEmbedCustom] = useState(false);
  const [chatCustom, setChatCustom] = useState(false);
  const [expiryInput, setExpiryInput] = useState<string>("");
  const [metadataSyncing, setMetadataSyncing] = useState(false);
  const [metadataSyncFields, setMetadataSyncFields] = useState<string[]>([
    "all",
  ]);
  const [metadataSyncStatus, setMetadataSyncStatus] = useState<{
    running: boolean;
    total: number;
    done: number;
    failed: number;
    skipped: number;
    current_title: string | null;
    last_error: string | null;
  } | null>(null);
  const [aiProcessingAction, setAiProcessingAction] = useState<string | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [navPreview, setNavPreview] = useState<"home" | "library" | "settings">(
    "home"
  );
  const [bgUploading, setBgUploading] = useState(false);
  const [paletteColors, setPaletteColors] = useState<string[]>([]);
  const [paletteLoading, setPaletteLoading] = useState(false);
  const [customFontDraft, setCustomFontDraft] = useState("");
  const [themeNameDraft, setThemeNameDraft] = useState("");
  const [bgLibrary, setBgLibrary] = useState<
    {
      id: string;
      url: string;
      mime: string;
      animated: boolean;
      filename?: string;
    }[]
  >([]);
  const [lastUploadedName, setLastUploadedName] = useState<string | null>(null);

  const q = searchQuery.trim().toLowerCase();
  const match = (...parts: (string | undefined | null)[]) =>
    matchesQuery(q, ...parts);

  const refreshAiStatus = () =>
    api
      .getAiStatus()
      .then(setAiStatus)
      .catch(() => setAiStatus(null));

  useEffect(() => {
    api.storageStats().then(setStorage).catch(() => undefined);
    api
      .getAppSettings()
      .then((s) => {
        setAppSettings(s);
        setExpiryInput(String(s.progress_expiry_days));
        if (s.ai) {
          const merged = { ...DEFAULT_AI, ...s.ai };
          setAiDraft(merged);
          setEmbedCustom(
            !EMBED_MODEL_OPTIONS.some(
              (o) => o.value !== "__custom__" && o.value === merged.embed_model
            )
          );
          setChatCustom(
            !CHAT_MODEL_OPTIONS.some(
              (o) => o.value !== "__custom__" && o.value === merged.chat_model
            )
          );
        }
      })
      .catch(() => undefined);
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => undefined);
    refreshAiStatus();
  }, []);

  useEffect(() => {
    if (tab !== "ai") return;
    const id = setInterval(refreshAiStatus, 5000);
    return () => clearInterval(id);
  }, [tab]);

  const refreshSystemStats = () =>
    api
      .getSystemStats()
      .then(setSystemStats)
      .catch(() => setSystemStats(null));

  useEffect(() => {
    if (tab !== "system" && tab !== "ai") return;
    refreshSystemStats();
    const id = setInterval(refreshSystemStats, 3000);
    return () => clearInterval(id);
  }, [tab]);

  useEffect(() => {
    setPaletteColors([]);
  }, [settings.customBackgroundId]);

  const refreshBgLibrary = () =>
    api
      .listBackgrounds()
      .then((r) => setBgLibrary(r.items ?? []))
      .catch(() => setBgLibrary([]));

  useEffect(() => {
    if (
      settings.backgroundEffect === "custom-image" ||
      (tab === "appearance" &&
        settings.backgroundEffect !== "none")
    ) {
      refreshBgLibrary();
    }
  }, [settings.backgroundEffect, tab]);

  const selectTab = (next: SettingsTab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  // Cross-tab search: jump to the first tab that matches when the current one doesn't.
  useEffect(() => {
    if (!q) return;
    if (tabMatchesQuery(tab, q)) return;
    const next = firstMatchingTab(q);
    if (next && next !== tab) selectTab(next);
  }, [q, tab]);

  const saveAi = async (patch: Partial<AiSettings>) => {
    const next = { ...aiDraft, ...patch };
    setAiDraft(next);
    const updated = await api.updateAppSettings({ ai: patch }).catch(() => null);
    if (updated?.ai) {
      setAppSettings(updated);
      setAiDraft({ ...DEFAULT_AI, ...updated.ai });
    }
    refreshAiStatus();
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
    const fields =
      metadataSyncFields.includes("all") || metadataSyncFields.length === 0
        ? ["all"]
        : metadataSyncFields;
    const label = fields.includes("all") ? "all metadata" : fields.join(", ");
    if (
      !confirm(
        `Resync ${label} for all videos with a source URL?`
      )
    ) {
      return;
    }
    setMetadataSyncing(true);
    try {
      const result = await api.refreshMetadataBulk(undefined, fields);
      if (!result.started) {
        showToast(result.detail || "Could not start metadata sync");
        setMetadataSyncing(false);
        return;
      }
      showToast(result.detail || "Metadata sync started");
      const poll = async () => {
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const status = await api.getMetadataSyncStatus();
            setMetadataSyncStatus(status);
            if (!status.running) {
              showToast(
                `Synced ${status.done} video${status.done === 1 ? "" : "s"}` +
                  (status.failed ? ` (${status.failed} failed)` : "") +
                  (status.skipped ? ` (${status.skipped} skipped)` : "")
              );
              break;
            }
          } catch {
            break;
          }
        }
        setMetadataSyncing(false);
      };
      void poll();
    } catch (err) {
      showToast(
        err instanceof Error && err.message
          ? err.message
          : "Metadata sync failed"
      );
      setMetadataSyncing(false);
    }
  };

  const toggleSyncField = (field: string) => {
    setMetadataSyncFields((prev) => {
      if (field === "all") return ["all"];
      const withoutAll = prev.filter((f) => f !== "all");
      if (withoutAll.includes(field)) {
        const next = withoutAll.filter((f) => f !== field);
        return next.length === 0 ? ["all"] : next;
      }
      return [...withoutAll, field];
    });
  };

  const runAiProcess = async (
    action:
      | "all_recent"
      | "all_full"
      | "embeds"
      | "reindex_embeds"
      | "missing_tags"
      | "full_tags"
      | "categories"
  ) => {
    if (aiProcessingAction) return;
    setAiProcessingAction(action);
    try {
      const result = await api.processAiLibrary(action);
      showToast(result.detail || "Nothing to process");
      refreshAiStatus();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not enqueue library";
      showToast(msg);
    } finally {
      setAiProcessingAction(null);
    }
  };

  const saveModels = async () => {
    const embed = aiDraft.embed_model.trim();
    const chat = aiDraft.chat_model.trim();
    const prevEmbed = (
      appSettings?.ai.embed_model || DEFAULT_AI.embed_model
    ).trim();
    const embedChanged = embed !== prevEmbed;
    await saveAi({
      embed_model: embed,
      chat_model: chat,
    });
    if (embedChanged) {
      const rebuild = confirm(
        "Embedding model changed. Rebuild search indexes so semantic search, related videos, and category shelves use the new model? " +
          "After indexing finishes, refresh categories from Process library."
      );
      if (rebuild) {
        await runAiProcess("reindex_embeds");
        return;
      }
      showToast(
        "Models saved — re-index later so category shelves use the new embed model"
      );
      refreshAiStatus();
      return;
    }
    showToast("Models saved");
    refreshAiStatus();
  };

  const uploadCustomBackground = async (file: File | null) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast("Large file (>10MB) — upload may be slow");
    }
    setBgUploading(true);
    const result = await api.uploadBackground(file).catch(() => null);
    setBgUploading(false);
    if (!result) {
      showToast("Background upload failed");
      return;
    }
    const name = result.filename || file.name;
    setLastUploadedName(name);
    update({
      backgroundEffect: "custom-image",
      customBackgroundId: result.id,
      customBackgroundMime: result.mime,
    });
    setPaletteColors([]);
    await refreshBgLibrary();
    showToast("Background uploaded");
  };

  const deleteLibraryBackground = async (id: string) => {
    const result = await api.deleteBackground(id).catch(() => null);
    if (!result?.ok) {
      showToast("Could not delete background");
      return;
    }
    if (settings.customBackgroundId === id) {
      const remaining = bgLibrary.filter((b) => b.id !== id);
      const next = remaining[0];
      if (next) {
        update({
          customBackgroundId: next.id,
          customBackgroundMime: next.mime,
        });
      } else {
        update({
          customBackgroundId: null,
          customBackgroundMime: null,
        });
      }
    }
    await refreshBgLibrary();
  };

  const saveCurrentAsTheme = () => {
    const name = themeNameDraft.trim();
    if (!name) {
      showToast("Enter a theme name");
      return;
    }
    const current = loadSettings();
    const preset: CustomThemePreset = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : String(Date.now()),
      name: name.slice(0, 64),
      customColors: { ...current.customColors },
      backgroundEffect: current.backgroundEffect,
      backgroundOpacity: current.backgroundOpacity,
      backgroundEffectSpeed: current.backgroundEffectSpeed,
      backgroundEffectSize: current.backgroundEffectSize,
      backgroundEffectColorMode: current.backgroundEffectColorMode,
      backgroundEffectColor: current.backgroundEffectColor,
      flowingGradientPreset: current.flowingGradientPreset,
      customBackgroundId: current.customBackgroundId,
      customBackgroundMime: current.customBackgroundMime,
      customBackgroundBlur: current.customBackgroundBlur,
      customBackgroundTint: current.customBackgroundTint,
      customBackgroundTintOpacity: current.customBackgroundTintOpacity,
      pauseBackgroundWhileWatching: current.pauseBackgroundWhileWatching,
      navIndicator: current.navIndicator,
      hoverMotion: current.hoverMotion,
      translucentPanels: current.translucentPanels,
      translucentPanelStrength: current.translucentPanelStrength,
      translucentPanelLegibility: current.translucentPanelLegibility,
      loadingStyle: current.loadingStyle,
      fontSize: current.fontSize,
      uiFont: current.uiFont === "custom" ? "default" : current.uiFont,
    };
    update({ customThemes: [...current.customThemes, preset] });
    setThemeNameDraft("");
    showToast(`Saved theme “${preset.name}”`);
  };

  const addCustomFontFromUrl = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const parsed = parseCustomFontInput(trimmed);
    if (!parsed.family || !parsed.cssUrl) {
      showToast("Could not parse that font");
      return;
    }
    const current = loadSettings();
    const existing = current.customFonts.find(
      (f) =>
        f.source === "url" &&
        (f.url === trimmed || f.name.toLowerCase() === parsed.family!.toLowerCase())
    );
    if (existing) {
      update({ uiFont: existing.id });
      setCustomFontDraft("");
      showToast(`“${existing.name}” is already saved`);
      return;
    }
    const id = newCustomFontId();
    update({
      customFonts: [
        ...current.customFonts,
        { id, name: parsed.family, source: "url", url: trimmed },
      ],
      uiFont: id,
    });
    setCustomFontDraft("");
    showToast(`Saved “${parsed.family}”`);
  };

  const applyCustomTheme = (preset: CustomThemePreset) => {
    update({
      theme: "custom",
      customColors: { ...preset.customColors },
      backgroundEffect: preset.backgroundEffect,
      backgroundOpacity: preset.backgroundOpacity,
      backgroundEffectSpeed: preset.backgroundEffectSpeed,
      backgroundEffectSize: preset.backgroundEffectSize,
      backgroundEffectColorMode: preset.backgroundEffectColorMode,
      backgroundEffectColor: preset.backgroundEffectColor,
      flowingGradientPreset: preset.flowingGradientPreset,
      customBackgroundId: preset.customBackgroundId,
      customBackgroundMime: preset.customBackgroundMime,
      customBackgroundBlur: preset.customBackgroundBlur,
      customBackgroundTint: preset.customBackgroundTint,
      customBackgroundTintOpacity: preset.customBackgroundTintOpacity,
      pauseBackgroundWhileWatching: preset.pauseBackgroundWhileWatching,
      navIndicator: preset.navIndicator,
      hoverMotion: preset.hoverMotion,
      translucentPanels: preset.translucentPanels,
      translucentPanelStrength: preset.translucentPanelStrength,
      translucentPanelLegibility: preset.translucentPanelLegibility,
      loadingStyle: preset.loadingStyle,
      fontSize: preset.fontSize,
      uiFont: preset.uiFont,
    });
    showToast(`Applied “${preset.name}”`);
  };

  const deleteCustomTheme = (id: string) => {
    update({
      customThemes: settings.customThemes.filter((t) => t.id !== id),
    });
  };

  const extractPalette = async () => {
    if (!settings.customBackgroundId || paletteLoading) return;
    setPaletteLoading(true);
    const result = await api
      .extractBackgroundPalette(settings.customBackgroundId)
      .catch(() => null);
    setPaletteLoading(false);
    if (!result?.colors?.length) {
      showToast("Could not extract palette");
      return;
    }
    setPaletteColors(result.colors);
  };

  const applyPaletteColor = (color: string) => {
    const hex = color.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const dark = `#${Math.round(r * 0.12)
      .toString(16)
      .padStart(2, "0")}${Math.round(g * 0.12)
      .toString(16)
      .padStart(2, "0")}${Math.round(b * 0.12)
      .toString(16)
      .padStart(2, "0")}`;
    update({
      theme: "custom",
      customColors: {
        accent: color.toLowerCase(),
        background: dark,
      },
      customBackgroundTint: dark,
    });
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold text-gray-100">Settings</h1>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <LiquidNav
          className="ui-panel inline-flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-ink-900 p-1 ring-1 ring-ink-700"
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
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Search settings"
          className="ui-panel ml-auto w-36 shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-gray-100 outline-none placeholder:text-gray-500 focus:border-accent sm:w-44"
        />
      </div>

      <div
        role="tabpanel"
        className="ui-panel space-y-6 rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700"
      >
        {tab === "appearance" && (
          <>
            <div
              className={
                match(
                  "theme",
                  "color palette",
                  "chrome",
                  "custom",
                  "saved themes",
                  "save theme",
                  "save current",
                  "preset",
                  "snapshot"
                )
                  ? undefined
                  : q
                    ? "hidden"
                    : undefined
              }
            >
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                Theme
              </h2>
              <p className="mb-3 text-xs text-gray-500">
                Choose a color palette. Snapshot the current Appearance choices
                — colors, background, font, and UI — then reapply later.
              </p>
              <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
                <div>
                  <p className="mb-2 text-sm font-medium text-gray-200">
                    Palette
                  </p>
                  <ThemedSelect
                    aria-label="Theme"
                    value={settings.theme}
                    options={THEMES.map((t) => ({
                      value: t.value,
                      label: t.label,
                    }))}
                    onChange={(value) => update({ theme: value })}
                    className="w-full min-w-[12rem] max-w-[18rem]"
                  />
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium text-gray-200">
                    Save theme
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={themeNameDraft}
                      onChange={(e) => setThemeNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          saveCurrentAsTheme();
                        }
                      }}
                      placeholder="Theme name"
                      maxLength={64}
                      aria-label="Theme name"
                      className={`${INPUT} min-w-0 flex-1`}
                    />
                    <button
                      type="button"
                      onClick={saveCurrentAsTheme}
                      className={PANEL_BTN}
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
              {settings.customThemes.length > 0 && (
                <ul className="mt-4 space-y-2">
                  {settings.customThemes.map((preset) => (
                    <li
                      key={preset.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2"
                    >
                      <span className="truncate text-sm text-gray-200">
                        {preset.name}
                      </span>
                      <span className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          onClick={() => applyCustomTheme(preset)}
                          className={PANEL_BTN}
                        >
                          Apply
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteCustomTheme(preset.id)}
                          className={PANEL_BTN}
                        >
                          Delete
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Collapse open={settings.theme === "custom"}>
                <div className="mt-4 max-w-xl space-y-3 rounded-lg border border-ink-700 bg-ink-950 p-4">
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
            </div>

            <div
              className={
                match(
                  "font",
                  "typeface",
                  "typography",
                  "google fonts",
                  "jetbrains",
                  "roboto",
                  "ubuntu",
                  "oxanium",
                  "source sans",
                  "font size",
                  "text size"
                )
                  ? "border-t border-ink-700 pt-6"
                  : q
                    ? "hidden"
                    : "border-t border-ink-700 pt-6"
              }
            >
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                Font
              </h2>
              <p className="mb-3 text-xs text-gray-500">
                App typeface and size. Inter (default) keeps the current stack.
              </p>
              <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
                <div
                  className={
                    match(
                      "font",
                      "typeface",
                      "typography",
                      "google fonts",
                      "jetbrains",
                      "roboto",
                      "ubuntu",
                        "oxanium",
                        "source sans",
                        "electrolize"
                      )
                      ? undefined
                      : q
                        ? "hidden"
                        : undefined
                  }
                >
                  <p className="mb-2 text-sm font-medium text-gray-200">
                    Typeface
                  </p>
                  <ThemedSelect
                    aria-label="Font"
                    value={settings.uiFont}
                    options={fontSelectOptions(settings.customFonts)}
                    onChange={(value: UiFont) => update({ uiFont: value })}
                    className="w-full min-w-[12rem] max-w-[18rem]"
                  />
                  <p className="mt-2 text-sm text-gray-400">
                    The quick brown fox jumps over the lazy dog 0123456789
                  </p>
                </div>
                <div
                  className={
                    match(
                      "font size",
                      "text size",
                      "small",
                      "medium",
                      "large",
                      "xl"
                    )
                      ? undefined
                      : q
                        ? "hidden"
                        : undefined
                  }
                >
                  <p className="mb-2 text-sm font-medium text-gray-200">
                    Font size
                  </p>
                  <p className="mb-3 text-xs text-gray-500">
                    Scales text across the app without extreme zoom steps.
                  </p>
                  <div data-font-size-control className="flex flex-wrap gap-2">
                    {FONT_SIZE_OPTIONS.map((opt) => (
                      <Chip
                        key={opt.value}
                        active={settings.fontSize === opt.value}
                        onPointerDown={() => update({ fontSize: opt.value })}
                        className="!py-1.5"
                      >
                        {opt.label}
                      </Chip>
                    ))}
                  </div>
                </div>
              </div>

              {settings.uiFont === "custom" && (
                <div className="mt-4 w-full max-w-2xl space-y-3 rounded-lg border border-ink-700 bg-ink-950 p-4">
                  <label className="block space-y-1.5">
                    <span className="text-sm text-gray-300">
                      Google Fonts URL or family name
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="text"
                        value={customFontDraft}
                        onChange={(e) => setCustomFontDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addCustomFontFromUrl(customFontDraft);
                          }
                        }}
                        placeholder="e.g. Nunito or fonts.googleapis.com/css2?family=…"
                        className={`${INPUT} flex-1`}
                      />
                      <button
                        type="button"
                        className={PANEL_BTN}
                        onClick={() => addCustomFontFromUrl(customFontDraft)}
                      >
                        Add
                      </button>
                    </div>
                  </label>
                  <div className="space-y-1.5">
                    <span className="block text-sm text-gray-300">
                      Or upload a font file
                    </span>
                    <input
                      type="file"
                      accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
                      className="block w-full max-w-md text-sm text-gray-400 file:mr-3 file:rounded-lg file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-sm file:text-gray-200"
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null;
                        e.target.value = "";
                        if (!file) return;
                        void (async () => {
                          try {
                            const result = await api.uploadFont(file);
                            const name = labelFromFilename(
                              result.filename || file.name
                            );
                            const current = loadSettings();
                            update({
                              customFonts: [
                                ...current.customFonts,
                                {
                                  id: result.id,
                                  name,
                                  source: "file",
                                },
                              ],
                              uiFont: result.id,
                            });
                            showToast(`Saved “${name}”`);
                          } catch {
                            showToast("Font upload failed");
                          }
                        })();
                      }}
                    />
                    <p className="text-xs text-gray-500">
                      Saved fonts are added to the dropdown permanently and
                      stored with your Horde data.
                    </p>
                  </div>
                </div>
              )}

              {settings.customFonts.some((f) => f.id === settings.uiFont) && (
                <button
                  type="button"
                  className={`${PANEL_BTN} mt-4`}
                  onClick={() => {
                    const id = settings.uiFont;
                    const entry = settings.customFonts.find((f) => f.id === id);
                    const next = loadSettings().customFonts.filter(
                      (f) => f.id !== id
                    );
                    if (entry?.source === "file") {
                      void api.deleteFont(id).catch(() => undefined);
                    }
                    update({
                      customFonts: next,
                      uiFont: "default",
                    });
                    showToast("Removed custom font");
                  }}
                >
                  Remove from dropdown
                </button>
              )}
            </div>

            <Section
              title="Background"
              description="Atmospheric effects and custom images behind the UI."
              hidden={
                !!q &&
                !match(
                  "background",
                  "animation",
                  "atmospheric",
                  "effects",
                  "intensity",
                  "speed",
                  "size",
                  "color",
                  "pause while watching",
                  "custom image",
                  "upload",
                  "blur",
                  "tint",
                  "palette",
                  "flowing",
                  "rgb",
                  "wave",
                  "cool",
                  "warm",
                  "mono"
                )
              }
            >
              {settings.backgroundEffect === "none" ? (
                <div>
                  <p className="mb-2 text-sm font-medium text-gray-200">
                    Animation
                  </p>
                  <ThemedSelect
                    aria-label="Background animation"
                    value={settings.backgroundEffect}
                    options={BACKGROUND_EFFECT_OPTIONS.map((o) => ({
                      value: o.value,
                      label: o.label,
                    }))}
                    onChange={(value) =>
                      update({ backgroundEffect: value as BackgroundEffect })
                    }
                    className="w-[12rem] min-w-[11rem]"
                  />
                  <p className="mt-2 text-xs text-gray-500">
                    {
                      BACKGROUND_EFFECT_OPTIONS.find(
                        (o) => o.value === settings.backgroundEffect
                      )?.description
                    }
                  </p>
                </div>
              ) : settings.backgroundEffect === "custom-image" ? (
                <div className="space-y-4">
                  <div>
                    <p className="mb-2 text-sm font-medium text-gray-200">
                      Animation
                    </p>
                    <ThemedSelect
                      aria-label="Background animation"
                      value={settings.backgroundEffect}
                      options={BACKGROUND_EFFECT_OPTIONS.map((o) => ({
                        value: o.value,
                        label: o.label,
                      }))}
                      onChange={(value) =>
                        update({ backgroundEffect: value as BackgroundEffect })
                      }
                      className="w-[12rem] min-w-[11rem]"
                    />
                    <p className="mt-2 text-xs text-gray-500">
                      {
                        BACKGROUND_EFFECT_OPTIONS.find(
                          (o) => o.value === settings.backgroundEffect
                        )?.description
                      }
                    </p>
                  </div>

                  <label className="block">
                    <span className="mb-1 block text-xs text-gray-500">
                      Image or GIF / WebM
                    </span>
                    <input
                      type="file"
                      accept=".jpg,.jpeg,.png,.webp,.gif,.webm,image/*,video/webm"
                      disabled={bgUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null;
                        e.target.value = "";
                        void uploadCustomBackground(file);
                      }}
                      className="block w-full max-w-md text-sm text-gray-400 file:mr-3 file:rounded-lg file:border file:border-ink-700 file:bg-ink-900 file:px-3 file:py-1.5 file:text-sm file:text-gray-200 hover:file:border-accent"
                    />
                    {bgUploading ? (
                      <p className="mt-1 text-xs text-gray-500">Uploading…</p>
                    ) : lastUploadedName ? (
                      <p className="mt-1 text-xs text-gray-500">
                        Uploaded: {lastUploadedName}
                      </p>
                    ) : null}
                  </label>

                  {bgLibrary.length > 0 && (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {bgLibrary.map((item) => {
                        const selected =
                          settings.customBackgroundId === item.id;
                        return (
                          <div
                            key={item.id}
                            className={`group relative overflow-hidden rounded-lg border bg-ink-950 ${
                              selected
                                ? "border-accent ring-2 ring-accent"
                                : "border-ink-700"
                            }`}
                          >
                            <button
                              type="button"
                              title={item.filename || item.id}
                              onClick={() =>
                                update({
                                  backgroundEffect: "custom-image",
                                  customBackgroundId: item.id,
                                  customBackgroundMime: item.mime,
                                })
                              }
                              className="block w-full"
                            >
                              {(item.mime || "").startsWith("video/") ? (
                                <video
                                  src={item.url || `/api/backgrounds/${item.id}`}
                                  className="aspect-video w-full object-cover"
                                  muted
                                  loop
                                  playsInline
                                />
                              ) : (
                                <img
                                  src={item.url || `/api/backgrounds/${item.id}`}
                                  alt={item.filename || "Background"}
                                  className="aspect-video w-full object-cover"
                                />
                              )}
                            </button>
                            <button
                              type="button"
                              aria-label="Delete background"
                              onClick={(e) => {
                                e.stopPropagation();
                                void deleteLibraryBackground(item.id);
                              }}
                              className="absolute right-1 top-1 rounded bg-ink-950/80 px-1.5 py-0.5 text-[10px] text-gray-300 opacity-0 ring-1 ring-ink-700 transition-opacity group-hover:opacity-100 hover:text-red-300"
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {settings.customBackgroundId && (
                    <div className="overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
                      {(settings.customBackgroundMime || "").startsWith(
                        "video/"
                      ) ? (
                        <video
                          src={`/api/backgrounds/${settings.customBackgroundId}`}
                          className="max-h-40 w-full object-cover"
                          muted
                          loop
                          autoPlay
                          playsInline
                        />
                      ) : (
                        <img
                          src={`/api/backgrounds/${settings.customBackgroundId}`}
                          alt="Custom background preview"
                          className="max-h-40 w-full object-cover"
                        />
                      )}
                    </div>
                  )}

                  <label className="block">
                    <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                      <span>Blur</span>
                      <span className="tabular-nums text-gray-500">
                        {Math.round(settings.customBackgroundBlur)}px
                      </span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={40}
                      step={1}
                      value={settings.customBackgroundBlur}
                      onChange={(e) =>
                        update({
                          customBackgroundBlur: Number(e.target.value),
                        })
                      }
                      className="accent-scrubber w-full"
                    />
                  </label>

                  <div className="flex flex-wrap items-end gap-4">
                    <label className="flex items-center gap-3">
                      <span className="text-sm text-gray-300">Tint</span>
                      <input
                        type="color"
                        value={settings.customBackgroundTint}
                        onChange={(e) =>
                          update({ customBackgroundTint: e.target.value })
                        }
                        className="h-9 w-14 cursor-pointer rounded border border-ink-700 bg-transparent p-0.5"
                      />
                    </label>
                    <label className="block min-w-[12rem] flex-1">
                      <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                        <span>Tint opacity</span>
                        <span className="tabular-nums text-gray-500">
                          {Math.round(
                            settings.customBackgroundTintOpacity * 100
                          )}
                          %
                        </span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={settings.customBackgroundTintOpacity}
                        onChange={(e) =>
                          update({
                            customBackgroundTintOpacity: Number(
                              e.target.value
                            ),
                          })
                        }
                        className="accent-scrubber w-full"
                      />
                    </label>
                  </div>

                  <div>
                    <button
                      type="button"
                      disabled={
                        !settings.customBackgroundId || paletteLoading
                      }
                      onClick={() => void extractPalette()}
                      className={PANEL_BTN}
                    >
                      {paletteLoading ? "Extracting…" : "Extract palette"}
                    </button>
                    {paletteColors.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {paletteColors.map((c) => (
                          <button
                            key={c}
                            type="button"
                            title={`Use ${c} as accent`}
                            onClick={() => applyPaletteColor(c)}
                            className="ui-interactive h-8 w-8 rounded-full ring-1 ring-ink-700 hover:ring-accent"
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
                    <div>
                      <p className="mb-2 text-sm font-medium text-gray-200">
                        Animation
                      </p>
                      <ThemedSelect
                        aria-label="Background animation"
                        value={settings.backgroundEffect}
                        options={BACKGROUND_EFFECT_OPTIONS.map((o) => ({
                          value: o.value,
                          label: o.label,
                        }))}
                        onChange={(value) =>
                          update({
                            backgroundEffect: value as BackgroundEffect,
                          })
                        }
                        className="w-[12rem] min-w-[11rem]"
                      />
                      <p className="mt-2 text-xs text-gray-500">
                        {
                          BACKGROUND_EFFECT_OPTIONS.find(
                            (o) => o.value === settings.backgroundEffect
                          )?.description
                        }
                      </p>
                    </div>
                    <div>
                      <p className="mb-2 text-sm font-medium text-gray-200">
                        Color
                      </p>
                      <div className="mb-3 flex flex-wrap gap-2">
                        {(
                          [
                            { value: "accent", label: "Match theme accent" },
                            { value: "custom", label: "Custom" },
                          ] as const
                        ).map((opt) => (
                          <Chip
                            key={opt.value}
                            active={
                              settings.backgroundEffectColorMode === opt.value
                            }
                            onClick={() =>
                              update({ backgroundEffectColorMode: opt.value })
                            }
                          >
                            {opt.label}
                          </Chip>
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
                              update({
                                backgroundEffectColor: e.target.value,
                              })
                            }
                            className="h-9 w-14 cursor-pointer rounded border border-ink-700 bg-transparent p-0.5"
                          />
                        </label>
                      )}
                    </div>
                  </div>

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

                  {settings.backgroundEffect === "flowing-gradient" && (
                    <div>
                      <p className="mb-2 text-sm text-gray-300">
                        Flowing palette
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {FLOWING_PRESET_OPTIONS.map((opt) => (
                          <Chip
                            key={opt.value}
                            active={
                              settings.flowingGradientPreset === opt.value
                            }
                            onClick={() =>
                              update({
                                flowingGradientPreset:
                                  opt.value as FlowingGradientPreset,
                              })
                            }
                          >
                            {opt.label}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  )}

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
              )}
            </Section>

            <Section
              title="UI"
              description="Motion, panels, and loading chrome. Reduced automatically when the system prefers less motion."
              hidden={
                !!q &&
                !match(
                  "interface motion",
                  "ui",
                  "navigation indicator",
                  "nav",
                  "liquid",
                  "jelly",
                  "underline",
                  "fade",
                  "glow",
                  "lift",
                  "hover motion",
                  "translucent panels",
                  "panel transparency",
                  "legibility",
                  "loading animation",
                  "dots",
                  "spinner",
                  "bar"
                )
              }
            >
              <div className="space-y-5">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                      <div
                        className={`min-w-0 flex-1 ${
                          match(
                            "navigation indicator",
                            "nav",
                            "liquid",
                            "jelly",
                            "underline",
                            "fade"
                          )
                            ? ""
                            : q
                              ? "hidden"
                              : ""
                        }`}
                      >
                        <p className="mb-2 text-sm font-medium text-gray-200">
                          Navigation indicator
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {NAV_INDICATOR_OPTIONS.map((opt) => (
                            <Chip
                              key={opt.value}
                              active={settings.navIndicator === opt.value}
                              onClick={() =>
                                update({ navIndicator: opt.value })
                              }
                            >
                              {opt.label}
                            </Chip>
                          ))}
                        </div>
                        <p className="mt-2 text-xs text-gray-500">
                          {
                            NAV_INDICATOR_OPTIONS.find(
                              (o) => o.value === settings.navIndicator
                            )?.description
                          }
                        </p>
                        <LiquidNav
                          className="ui-panel mt-3 inline-flex w-fit gap-1 rounded-xl bg-ink-950 p-1 ring-1 ring-ink-700"
                          pillClassName="bg-ink-800"
                          dependency={navPreview}
                        >
                          {(
                            [
                              { id: "home", label: "Home" },
                              { id: "library", label: "Library" },
                              { id: "settings", label: "Settings" },
                            ] as const
                          ).map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              data-liquid-active={
                                navPreview === item.id ? "true" : undefined
                              }
                              onClick={() => setNavPreview(item.id)}
                              className={`ui-interactive relative z-10 shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                                navPreview === item.id
                                  ? settings.navIndicator !== "none"
                                    ? "text-gray-100"
                                    : "bg-ink-800 text-gray-100"
                                  : "text-gray-400 hover:text-gray-200"
                              }`}
                            >
                              {item.label}
                            </button>
                          ))}
                        </LiquidNav>
                      </div>

                      <div
                        className={`min-w-0 flex-1 ${
                          match(
                            "hover motion",
                            "cards",
                            "controls",
                            "glow",
                            "lift"
                          )
                            ? ""
                            : q
                              ? "hidden"
                              : ""
                        }`}
                      >
                        <p className="mb-2 text-sm font-medium text-gray-200">
                          Hover motion
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {HOVER_MOTION_OPTIONS.map((opt) => (
                            <Chip
                              key={opt.value}
                              active={settings.hoverMotion === opt.value}
                              onClick={() =>
                                update({ hoverMotion: opt.value })
                              }
                            >
                              {opt.label}
                            </Chip>
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
                    </div>

                    <div
                      className={
                        match(
                          "translucent panels",
                          "panel transparency",
                          "legibility"
                        )
                          ? undefined
                          : q
                            ? "hidden"
                            : undefined
                      }
                    >
                      <SettingRow
                        title="Translucent panels"
                        description="Let background effects show through cards and chrome."
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
                        <div className="mt-3 space-y-3">
                          <label className="block">
                            <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                              <span>Transparency</span>
                              <span className="tabular-nums text-gray-500">
                                {Math.round(
                                  settings.translucentPanelStrength * 100
                                )}
                                %
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
                                  translucentPanelStrength: Number(
                                    e.target.value
                                  ),
                                })
                              }
                              className="accent-scrubber w-full"
                            />
                          </label>
                          <SettingRow
                            title="Improve legibility"
                            description="Raise opacity on panels that need readable text."
                            control={
                              <Toggle
                                checked={settings.translucentPanelLegibility}
                                onChange={() =>
                                  update({
                                    translucentPanelLegibility:
                                      !settings.translucentPanelLegibility,
                                  })
                                }
                              />
                            }
                          />
                        </div>
                      </Collapse>
                    </div>

                    <div
                      className={
                        match("loading animation", "dots", "spinner", "bar")
                          ? undefined
                          : q
                            ? "hidden"
                            : undefined
                      }
                    >
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
                          <Chip
                            key={opt.value}
                            active={settings.loadingStyle === opt.value}
                            onClick={() => update({ loadingStyle: opt.value })}
                            className="!py-1.5"
                          >
                            {opt.label}
                          </Chip>
                        ))}
                      </div>
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
              description="Pull fresh thumbnails, captions, view counts, and titles from each video's source URL. Choose what to sync."
              hidden={
                !match(
                  "library metadata",
                  "resync",
                  "thumbnails",
                  "captions",
                  "view counts"
                )
              }
            >
              <div className="mb-3 flex flex-wrap gap-2">
                {(
                  [
                    ["all", "Everything"],
                    ["views", "Views"],
                    ["thumbnails", "Thumbnails"],
                    ["captions", "Captions"],
                    ["titles_descriptions", "Titles & descriptions"],
                  ] as const
                ).map(([value, label]) => (
                  <Chip
                    key={value}
                    active={
                      value === "all"
                        ? metadataSyncFields.includes("all")
                        : metadataSyncFields.includes(value) &&
                          !metadataSyncFields.includes("all")
                    }
                    onClick={() => toggleSyncField(value)}
                    className="!py-1.5"
                  >
                    {label}
                  </Chip>
                ))}
              </div>
              <button
                onClick={resyncAllMetadata}
                disabled={metadataSyncing}
                className={PANEL_BTN}
              >
                {metadataSyncing ? "Syncing…" : "Resync metadata"}
              </button>
              {metadataSyncing && metadataSyncStatus && (
                <div className="mt-3 rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-2 text-xs text-gray-400">
                  <p>
                    {metadataSyncStatus.done + metadataSyncStatus.failed}/
                    {metadataSyncStatus.total}
                    {metadataSyncStatus.current_title
                      ? ` — ${metadataSyncStatus.current_title}`
                      : ""}
                  </p>
                  {metadataSyncStatus.last_error && (
                    <p className="mt-1 text-red-400">
                      {metadataSyncStatus.last_error}
                    </p>
                  )}
                </div>
              )}
            </Section>

            <Section
              title="Homepage"
              description="Homepage and continue watching preferences."
              hidden={
                !match(
                  "homepage",
                  "continue watching",
                  "progress bar",
                  "dates",
                  "video cards"
                )
              }
            >
              <div className="space-y-4">
                <SettingRow
                  title="Show continue watching"
                  description="Display the continue watching row on the library home page."
                  hidden={
                    !!q && !match("continue watching", "homepage")
                  }
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
                  hidden={
                    !!q &&
                    !match("progress bar", "continue watching")
                  }
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
                  hidden={
                    !!q && !match("progress bar", "library videos")
                  }
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
                  hidden={!!q && !match("dates", "video cards")}
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
              hidden={!match("progress expiry", "inactivity", "days")}
            >
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={expiryInput}
                  onChange={(e) => setExpiryInput(e.target.value)}
                  className="ui-panel w-24 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
                />
                <button
                  onClick={saveExpiry}
                  disabled={
                    !appSettings ||
                    parseInt(expiryInput, 10) ===
                      appSettings.progress_expiry_days
                  }
                  className={PANEL_BTN}
                >
                  Save
                </button>
              </div>
            </Section>

            <Section
              title="Default video sort"
              description="Used when you open the library or after a temporary sort expires (3 hours)."
              hidden={!match("default video sort", "sort", "library")}
            >
              <div className="flex flex-wrap gap-2">
                {LIBRARY_SORT_OPTIONS.filter((o) => o.value !== "random").map(
                  (opt) => (
                    <Chip
                      key={opt.value}
                      active={settings.defaultLibrarySort === opt.value}
                      onClick={() =>
                        update({ defaultLibrarySort: opt.value as LibrarySort })
                      }
                    >
                      {opt.label}
                    </Chip>
                  )
                )}
              </div>
            </Section>

            <Section
              title="Channel list order (sidebar)"
              hidden={
                !match(
                  "channel list order",
                  "sidebar",
                  "ascending",
                  "descending"
                )
              }
            >
              <div className="mb-3 flex flex-wrap gap-2">
                {CHANNEL_SORT_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.value}
                    active={settings.channelSort === opt.value}
                    onClick={() => update({ channelSort: opt.value })}
                  >
                    {opt.label}
                  </Chip>
                ))}
              </div>
              <div className="flex gap-2">
                {(["desc", "asc"] as const).map((dir) => (
                  <Chip
                    key={dir}
                    active={settings.channelOrder === dir}
                    onClick={() => update({ channelOrder: dir })}
                  >
                    {dir === "desc" ? "Descending" : "Ascending"}
                  </Chip>
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
              hidden={
                !match(
                  "watch page",
                  "description",
                  "related videos",
                  "autoplay"
                )
              }
            >
              <div className="space-y-4">
                <SettingRow
                  title="Show description"
                  description="Display the video description on the watch page."
                  hidden={!!q && !match("description", "watch page")}
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
                  hidden={!!q && !match("related videos", "sidebar")}
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
                <SettingRow
                  title="Autoplay related"
                  description="When a video ends and the queue is empty, count down and play a related video. Also available in the player controls."
                  hidden={!!q && !match("autoplay related")}
                  control={
                    <Toggle
                      checked={settings.autoplayRelated}
                      onChange={() =>
                        update({
                          autoplayRelated: !settings.autoplayRelated,
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
              hidden={!match("subtitles", "caption", "vertical position")}
            >
              <div className="mb-4 flex flex-wrap gap-2">
                {SUBTITLE_SIZES.map((opt) => (
                  <Chip
                    key={opt.value}
                    active={settings.subtitleSize === opt.value}
                    onClick={() => update({ subtitleSize: opt.value })}
                  >
                    {opt.label}
                  </Chip>
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
              hidden={
                !match(
                  "sponsorblock",
                  "sponsor",
                  "skip",
                  "ad",
                  "ads",
                  "advertising",
                  "commercial"
                )
              }
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
              hidden={!match("playback speed", "speed", "default")}
            >
              <div className="flex flex-wrap gap-2">
                {SPEED_STEPS.map((s) => (
                  <Chip
                    key={s}
                    active={settings.defaultPlaybackRate === s}
                    onClick={() => update({ defaultPlaybackRate: s })}
                    className="tabular-nums"
                  >
                    {s}x
                  </Chip>
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
            hidden={
              !match(
                "downloads",
                "download count",
                "normalize volume",
                "navigation"
              )
            }
          >
            <div className="space-y-4">
              <SettingRow
                title="Show download count in navigation"
                description="Badge on the Download tab while jobs are queued or in progress."
                hidden={!!q && !match("download count", "navigation", "badge")}
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
                hidden={!!q && !match("normalize volume", "loudness")}
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

        {tab === "ai" && (
          <>
            <Section
              first
              title="Ollama connection"
              description="Horde uses a local Ollama instance for embeddings and small LLM tasks. Leave the URL blank to auto-discover (compose sidecar or host.docker.internal)."
              hidden={
                !match(
                  "ollama",
                  "connection",
                  "enable ai",
                  "base url",
                  "queue",
                  "indexed",
                  "gpu",
                  "vram"
                )
              }
            >
              <div className="space-y-4">
                <div
                  className={
                    !!q && !match("enable ai", "features")
                      ? "hidden"
                      : "flex items-center gap-3"
                  }
                >
                  <span className="text-sm font-medium text-gray-200">
                    Enable Local AI
                  </span>
                  <Toggle
                    checked={aiDraft.enabled}
                    onChange={() => saveAi({ enabled: !aiDraft.enabled })}
                  />
                </div>
                <div className="max-w-md space-y-4">
                  <label className="block">
                    <span className="mb-1 block text-xs text-gray-500">
                      Ollama base URL
                    </span>
                    <input
                      value={aiDraft.base_url}
                      onChange={(e) =>
                        setAiDraft((d) => ({ ...d, base_url: e.target.value }))
                      }
                      onBlur={(e) =>
                        saveAi({ base_url: e.target.value.trim() })
                      }
                      placeholder="http://ollama:11434 or http://192.168.x.x:11434"
                      className={INPUT}
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={aiTesting}
                      onClick={async () => {
                        setAiTesting(true);
                        const result = await api
                          .testAiConnection(aiDraft.base_url || undefined)
                          .catch(() => null);
                        setAiTesting(false);
                        if (!result) {
                          showToast("Connection test failed");
                          return;
                        }
                        showToast(
                          result.ok
                            ? `Connected${result.base_url ? ` at ${result.base_url}` : ""}`
                            : result.detail || "Unreachable"
                        );
                        refreshAiStatus();
                      }}
                      className={PANEL_BTN}
                    >
                      {aiTesting ? "Testing…" : "Test connection"}
                    </button>
                    {aiStatus?.paused ? (
                      <button
                        type="button"
                        onClick={async () => {
                          await api.resumeAi().catch(() => undefined);
                          await saveAi({ paused: false });
                          showToast("AI queue resumed");
                        }}
                        className="ui-panel ui-interactive rounded-lg border border-accent/40 bg-accent/15 px-3 py-1.5 text-sm text-accent hover:bg-accent/25"
                      >
                        Resume queue
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          await api.pauseAi().catch(() => undefined);
                          await saveAi({ paused: true });
                          showToast("AI queue paused");
                        }}
                        className={PANEL_BTN}
                      >
                        Pause queue
                      </button>
                    )}
                    {aiStatus && (aiStatus.ready || aiStatus.reachable) && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/30">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        {aiStatus.ready ? "Connected" : "Reachable"}
                      </span>
                    )}
                  </div>
                  {aiStatus && (
                    <dl className="space-y-1.5 text-sm">
                      <div className="flex justify-between gap-3">
                        <dt className="text-gray-400">Status</dt>
                        <dd className="text-right text-gray-200">
                          {!aiStatus.enabled
                            ? "Disabled"
                            : aiStatus.ready
                              ? "Ready"
                              : aiStatus.reachable
                                ? "Connected (models loading)"
                                : "Offline"}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-gray-400">URL</dt>
                        <dd className="truncate text-right font-mono text-xs text-gray-300">
                          {aiStatus.base_url || "—"}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-gray-400">Indexed</dt>
                        <dd className="text-right text-gray-200">
                          {aiStatus.indexed_videos} / {aiStatus.total_videos}
                          {aiStatus.queue_depth > 0
                            ? ` · ${aiStatus.queue_depth} queued`
                            : ""}
                        </dd>
                      </div>
                      {aiStatus.indexed_videos < aiStatus.total_videos && (
                        <p className="text-xs text-amber-400/90">
                          Some videos are not indexed yet — run “Index missing”
                          or “Run all” so category shelves and search stay accurate.
                          After changing the embed model, save models and rebuild
                          indexes, then refresh categories.
                        </p>
                      )}
                      {aiStatus.current_job && (
                        <CurrentAiJob job={aiStatus.current_job} />
                      )}
                      {systemStats?.gpu &&
                        (systemStats.gpu.util_percent != null ||
                          systemStats.gpu.temp_c != null) && (
                        <div className="flex justify-between gap-3">
                          <dt className="text-gray-400">GPU</dt>
                          <dd className="text-right text-gray-200">
                            {[
                              systemStats.gpu.util_percent != null
                                ? `${Math.round(systemStats.gpu.util_percent)}%`
                                : null,
                              systemStats.gpu.temp_c != null
                                ? `${Math.round(systemStats.gpu.temp_c)}°C`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </dd>
                        </div>
                      )}
                      {aiStatus.queue_breakdown &&
                        aiStatus.queue_depth > 0 && (
                          <div className="flex justify-between gap-3">
                            <dt className="text-gray-400">Queue</dt>
                            <dd className="text-right text-xs text-gray-300">
                              {[
                                aiStatus.queue_breakdown.embed_video
                                  ? plural(
                                      aiStatus.queue_breakdown.embed_video,
                                      "search index",
                                      "search indexes"
                                    )
                                  : null,
                                aiStatus.queue_breakdown.enrich_tags
                                  ? plural(
                                      aiStatus.queue_breakdown.enrich_tags,
                                      "tag",
                                      "tags"
                                    )
                                  : null,
                                aiStatus.queue_breakdown.refresh_categories
                                  ? plural(
                                      aiStatus.queue_breakdown
                                        .refresh_categories,
                                      "category",
                                      "categories"
                                    )
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ") || `${aiStatus.queue_depth} jobs`}
                            </dd>
                          </div>
                        )}
                      {aiStatus.pulling.length > 0 && (
                        <div className="flex justify-between gap-3">
                          <dt className="text-gray-400">Pulling</dt>
                          <dd className="text-right text-amber-300">
                            {aiStatus.pulling.join(", ")}
                          </dd>
                        </div>
                      )}
                      {aiStatus.last_error && (
                        <p className="text-xs text-red-400">
                          {aiStatus.last_error}
                        </p>
                      )}
                    </dl>
                  )}
                </div>
              </div>
            </Section>

            <Section
              title="Models"
              description="Models are pulled automatically on first connect when auto-pull is enabled."
              hidden={
                !match(
                  "models",
                  "embedding",
                  "chat model",
                  "vram",
                  "auto-pull",
                  "gpu"
                )
              }
            >
              <div className="max-w-md space-y-3">
                <label className="block">
                  <span className="mb-1 flex items-center gap-1.5 text-xs text-gray-500">
                    Embedding model
                    <HelpTip text={EMBED_MODEL_TIP} />
                  </span>
                  <ThemedSelect
                    aria-label="Embedding model"
                    value={embedCustom ? "__custom__" : aiDraft.embed_model}
                    options={EMBED_MODEL_OPTIONS}
                    onChange={(value) => {
                      if (value === "__custom__") {
                        setEmbedCustom(true);
                        return;
                      }
                      setEmbedCustom(false);
                      setAiDraft((d) => ({
                        ...d,
                        embed_model: value,
                      }));
                    }}
                    className="w-full max-w-md"
                    buttonClassName="w-full"
                  />
                  {embedCustom && (
                    <input
                      value={aiDraft.embed_model}
                      onChange={(e) =>
                        setAiDraft((d) => ({
                          ...d,
                          embed_model: e.target.value,
                        }))
                      }
                      placeholder="Ollama model name"
                      className={`${INPUT} mt-2`}
                    />
                  )}
                </label>
                <label className="block">
                  <span className="mb-1 flex items-center gap-1.5 text-xs text-gray-500">
                    Chat model (tags, categories, duplicates)
                    <HelpTip text={CHAT_MODEL_TIP} />
                  </span>
                  <ThemedSelect
                    aria-label="Chat model"
                    value={chatCustom ? "__custom__" : aiDraft.chat_model}
                    options={CHAT_MODEL_OPTIONS}
                    onChange={(value) => {
                      if (value === "__custom__") {
                        setChatCustom(true);
                        return;
                      }
                      setChatCustom(false);
                      setAiDraft((d) => ({
                        ...d,
                        chat_model: value,
                      }));
                    }}
                    className="w-full max-w-md"
                    buttonClassName="w-full"
                  />
                  {chatCustom && (
                    <input
                      value={aiDraft.chat_model}
                      onChange={(e) =>
                        setAiDraft((d) => ({
                          ...d,
                          chat_model: e.target.value,
                        }))
                      }
                      placeholder="Ollama model name"
                      className={`${INPUT} mt-2`}
                    />
                  )}
                </label>
                <button
                  type="button"
                  onClick={() => void saveModels()}
                  className={PANEL_BTN}
                >
                  Save models
                </button>
                <SettingRow
                  title="Auto-pull missing models"
                  description="Ask Ollama to download configured models when they are missing."
                  control={
                    <Toggle
                      checked={aiDraft.auto_pull_models}
                      onChange={() =>
                        saveAi({ auto_pull_models: !aiDraft.auto_pull_models })
                      }
                    />
                  }
                />
              </div>
            </Section>

            <Section
              title="Process library"
              description="Queue search indexing, tagging, and category jobs on demand."
              hidden={
                !match(
                  "process",
                  "run all",
                  "recent",
                  "full",
                  "embeds",
                  "tags",
                  "categories"
                )
              }
            >
              <div className="max-w-md space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  {AI_PROCESS_PRIMARY.map((opt) => (
                    <button
                      key={opt.action}
                      type="button"
                      title={opt.title}
                      disabled={!!aiProcessingAction}
                      onClick={() => runAiProcess(opt.action)}
                      className={PROCESS_BTN}
                    >
                      {aiProcessingAction === opt.action
                        ? "Queuing…"
                        : opt.label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {AI_PROCESS_SECONDARY.map((opt) => (
                    <button
                      key={opt.action}
                      type="button"
                      title={opt.title}
                      disabled={!!aiProcessingAction}
                      onClick={() => runAiProcess(opt.action)}
                      className={PROCESS_BTN}
                    >
                      {aiProcessingAction === opt.action
                        ? "Queuing…"
                        : opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </Section>

            <Section
              title="When to run"
              description="Important for large libraries — process on a schedule or only when you ask."
              hidden={
                !match(
                  "when to run",
                  "schedule",
                  "timer",
                  "set time",
                  "on download",
                  "on request"
                )
              }
            >
              <div className="max-w-md space-y-3">
                <ThemedSelect
                  aria-label="AI schedule"
                  value={aiDraft.schedule}
                  options={AI_SCHEDULE_OPTIONS.map((o) => ({
                    value: o.value,
                    label: o.label,
                  }))}
                  onChange={(value) =>
                    saveAi({ schedule: value as AiSchedule })
                  }
                  className="w-full max-w-md"
                  buttonClassName="w-full"
                />
                <p className="text-xs text-gray-500">
                  {
                    AI_SCHEDULE_OPTIONS.find((o) => o.value === aiDraft.schedule)
                      ?.description
                  }
                </p>
                {aiDraft.schedule === "timer" && (
                  <label className="block">
                    <span className="mb-1 block text-xs text-gray-500">
                      Timer interval (hours)
                    </span>
                    <input
                      type="number"
                      min={0.25}
                      max={168}
                      step={0.25}
                      value={aiDraft.timer_hours}
                      onChange={(e) =>
                        setAiDraft((d) => ({
                          ...d,
                          timer_hours: Number(e.target.value) || 6,
                        }))
                      }
                      onBlur={(e) =>
                        saveAi({
                          timer_hours: Number(e.target.value) || 6,
                        })
                      }
                      className="ui-panel w-32 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
                    />
                  </label>
                )}
                {aiDraft.schedule === "set_time" && (
                  <label className="block">
                    <span className="mb-1 block text-xs text-gray-500">
                      Daily run time (local)
                    </span>
                    <input
                      type="time"
                      value={aiDraft.schedule_time || "03:00"}
                      onChange={(e) =>
                        setAiDraft((d) => ({
                          ...d,
                          schedule_time: e.target.value || "03:00",
                        }))
                      }
                      onBlur={(e) =>
                        saveAi({
                          schedule_time: e.target.value || "03:00",
                        })
                      }
                      className="ui-panel rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
                    />
                  </label>
                )}
              </div>
            </Section>

            <Section
              title="Features"
              description="Toggle individual AI jobs."
              hidden={
                !match(
                  "features",
                  "subtitles",
                  "enrich tags",
                  "duplicate",
                  "category",
                  "strictness"
                )
              }
            >
              <div className="space-y-3">
                <SettingRow
                  title="Use subtitles in search indexes"
                  description="Include caption text to improve semantic search, related videos, and category matching."
                  hidden={!!q && !match("subtitles", "embeddings", "search indexes")}
                  control={
                    <Toggle
                      checked={aiDraft.use_subtitles}
                      onChange={() =>
                        saveAi({ use_subtitles: !aiDraft.use_subtitles })
                      }
                    />
                  }
                />
                <SettingRow
                  title="Category match strictness"
                  description="Minimum similarity for videos under a category chip. Higher = fewer, tighter matches; lower = fuller, noisier shelves."
                  hidden={
                    !!q &&
                    !match(
                      "category",
                      "categories",
                      "strictness",
                      "match",
                      "score"
                    )
                  }
                  control={
                    <input
                      type="number"
                      min={0.2}
                      max={0.9}
                      step={0.05}
                      aria-label="Category match strictness"
                      value={aiDraft.category_min_score}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value);
                        if (Number.isNaN(n)) return;
                        setAiDraft((d) => ({
                          ...d,
                          category_min_score: n,
                        }));
                      }}
                      onBlur={(e) => {
                        const n = parseFloat(e.target.value);
                        const clamped = Math.min(
                          0.9,
                          Math.max(0.2, Number.isNaN(n) ? 0.55 : n)
                        );
                        const rounded = Math.round(clamped * 100) / 100;
                        void saveAi({ category_min_score: rounded });
                      }}
                      className="ui-panel w-24 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
                    />
                  }
                />
                <SettingRow
                  title="Enrich tags with LLM"
                  description="Suggest extra tags after download (skipped if you edit tags manually)."
                  hidden={!!q && !match("enrich tags", "llm")}
                  control={
                    <Toggle
                      checked={aiDraft.enrich_tags}
                      onChange={() =>
                        saveAi({ enrich_tags: !aiDraft.enrich_tags })
                      }
                    />
                  }
                />
                <SettingRow
                  title="AI duplicate confirmation"
                  description="Score heuristic duplicate groups in Import."
                  hidden={!!q && !match("duplicate", "confirmation")}
                  control={
                    <Toggle
                      checked={aiDraft.ai_duplicates}
                      onChange={() =>
                        saveAi({ ai_duplicates: !aiDraft.ai_duplicates })
                      }
                    />
                  }
                />
              </div>
            </Section>
          </>
        )}

        {tab === "system" && (
          <>
            <Section
              first
              title="Storage"
              hidden={!match("storage", "disk", "space", "library")}
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

            <Section
              title="Resources"
              hidden={
                !match(
                  "resources",
                  "cpu",
                  "ram",
                  "gpu",
                  "vram",
                  "temperature",
                  "nvidia",
                  "system"
                )
              }
            >
              <SystemStatsSnippet stats={systemStats} />
            </Section>

            <Section
              title="Status"
              hidden={
                !match(
                  "health",
                  "yt-dlp",
                  "ollama",
                  "disk",
                  "review",
                  "downloads",
                  "gpu",
                  "system status"
                )
              }
            >
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
                  {health.ollama && (
                    <div className="flex justify-between">
                      <dt className="text-gray-400">Ollama</dt>
                      <dd className="text-gray-200">
                        {!health.ollama.enabled
                          ? "Disabled"
                          : health.ollama.ready
                            ? "Ready"
                            : health.ollama.reachable
                              ? "Connected"
                              : "Offline"}
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
                    <dt className="text-gray-400">Pending import</dt>
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
