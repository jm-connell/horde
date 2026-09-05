import type {
  ChannelSort,
  FontSize,
  HoverMotion,
  NavIndicator,
  StreamQuality,
  SubtitleSize,
  Theme,
} from "../../hooks/useSettings";
import type {
  AiSchedule,
  AiSettings,
  AiSummaryLength,
  AiWorkloadProfile,
} from "../../types";
import type { AiProcessAction, SettingsTab } from "./types";

export const CHIP =
  "ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm font-medium text-gray-300 transition-colors hover:border-accent hover:text-gray-100";
export const CHIP_ACTIVE =
  "ui-panel ui-interactive rounded-lg border border-accent/50 bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition-colors";
export const PANEL_BTN =
  "ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-200 hover:border-accent disabled:cursor-not-allowed disabled:opacity-50";
export const INPUT =
  "ui-panel w-full max-w-md rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent";
/** Short values: numbers, filters, times. */
export const INPUT_COMPACT =
  "ui-panel w-28 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent";
/** Shorter host / URL fields beside action buttons. */
export const INPUT_INLINE =
  "ui-panel w-56 max-w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent";
/** Narrower API key field. */
export const INPUT_KEY =
  "ui-panel w-48 max-w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent";

export const CATALOG_INDEX_TIP =
  "YouTube channels only. When you download from a channel or open its feed, Horde indexes that channel’s uploads in the background (titles, then descriptions for the newest 200) so feed search works across the library without loading every page from YouTube. Non-YouTube sources are skipped. Settings → System → Refresh catalogs catches new channels and new uploads on ready catalogs; Full reindex re-walks every channel.";
export const CATALOG_MAX_TIP =
  "Maximum YouTube uploads to keep per channel. Values above 1000 can take a long time and may slow other YouTube work while indexing.";
export const DIRECT_YOUTUBE_SEARCH_TIP =
  "When on, channel search also queries YouTube for uploads that are not already in the results. Search text is sent to YouTube. YouTube-linked channels only; each channel can override this default.";
export const DIRECT_YOUTUBE_SEARCH_CHANNEL_TIP =
  "Also search YouTube for this channel. Search text is sent to YouTube. Overrides the Library default; Use default restores it.";
export const METADATA_INTERVAL_TIP =
  "How often Horde refreshes library video metadata and re-queues stale channel catalogs for a full index pass.";

export const STATUS_TIPS = {
  horde:
    "This Horde install’s version (short git SHA). Compared to GitHub so you can see if an update is available.",
  ytdlp:
    "The downloader Horde uses to fetch metadata and video files from YouTube and other sites. Keep it current — extractors break when sites change.",
  pot: "YouTube issues Proof-of-Origin (PO) tokens to tell real players from bots. Horde’s bgutil-pot sidecar mints them for yt-dlp. If this is down, downloads and previews often fail with bot-check errors.",
  ollama:
    "Local LLM used for summaries, tags, chat, and embeddings. Configure it under AI → Providers.",
  openrouter:
    "Optional cloud LLM for models you don’t run locally. Needs an API key under AI → Providers.",
  cookies:
    "Browser or Netscape cookies passed to yt-dlp. Needed for age gates, members-only videos you’re entitled to, or stubborn bot checks that PO tokens don’t clear. Public videos often work without them. This makes downloads significantly less anonymous — YouTube sees the logged-in account.",
  library:
    "How many videos Horde has in its database and how much space they use — downloads and imports, including any still waiting in the import queue.",
  pendingImport:
    "Files in the Import queue that still need a title and channel before they join the library (dropped or scanned media).",
  downloads:
    "Download jobs that are queued or in progress. “Paused” means the download queue is stopped.",
  aiQueue:
    "Background AI work (embeddings, tags, summaries). Depth is waiting jobs; running/failed show worker progress. A blocked reason means the provider isn’t usable.",
  catalogQueue:
    "Channel catalog indexing — walking YouTube upload lists so feed search works beyond the visible page.",
  extractFailure:
    "The most recent yt-dlp metadata error (bot check, cookies, PO token, and similar). Useful for diagnosing YouTube access problems.",
  disk: "Free space on the downloads volume versus total size. Downloads and imports will fail if this runs out.",
} as const;

export const FONT_SIZE_OPTIONS: { value: FontSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "xl", label: "XL" },
];

export const STREAM_QUALITY_OPTIONS: {
  value: StreamQuality;
  label: string;
}[] = [
  { value: "auto", label: "Auto" },
  { value: "2160", label: "4K" },
  { value: "1440", label: "1440p" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
];

export const AI_PROCESS_CATCH_UP: {
  action: AiProcessAction;
  label: string;
  description: string;
}[] = [
  {
    action: "all_recent",
    label: "Process recent",
    description:
      "Queue missing search indexes and AI tags for videos watched or added in the last 30 days, then refresh categories.",
  },
  {
    action: "all_full",
    label: "Process full library",
    description:
      "Queue missing search indexes and AI tags across the whole library, then refresh categories.",
  },
];

export const AI_PROCESS_JOBS: {
  action: AiProcessAction;
  label: string;
  description: string;
}[] = [
  {
    action: "embeds",
    label: "Index missing videos",
    description:
      "Build search indexes for videos that are missing, stale, or indexed with a different embed model.",
  },
  {
    action: "reindex_embeds",
    label: "Rebuild search indexes",
    description:
      "Force re-queue indexing for those videos (even if already queued) and refresh categories when done. Prefer this after changing the embed model.",
  },
  {
    action: "missing_tags",
    label: "Enrich missing tags",
    description:
      "Ask the chat model to suggest tags only for videos that do not have AI tags yet.",
  },
  {
    action: "full_tags",
    label: "Re-tag entire library",
    description:
      "Re-run AI tag enrichment for every unlocked video. Heavier than enriching missing tags only.",
  },
  {
    action: "categories",
    label: "Refresh categories",
    description:
      "Invent browse categories from a diverse sample, then rematch shelves via search indexes. Run after re-indexing if you changed the embed model.",
  },
];

export const EMBED_MODEL_TIP =
  "Search index model — used for semantic search, related videos, and filling category shelves. Much lighter on VRAM than chat (typically ~0.5–1GB). nomic-embed-text is a solid default; mxbai-embed-large is higher quality for category matching but heavier; all-minilm is the lightest. Changing this requires re-indexing the library.";
export const CHAT_MODEL_TIP =
  "Ollama chat model — used when OpenRouter is off. Invents recommendation category chips; also enriches tags and scores duplicates as a local fallback. Needs more VRAM than search indexes: 1B ≈ 1–2GB, 3B-class ≈ 3–6GB.";

export const SUBTITLE_SIZES: { value: SubtitleSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

export const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

export const CHANNEL_SORT_OPTIONS: { value: ChannelSort; label: string }[] = [
  { value: "recent_download", label: "Recent download" },
  { value: "video_count", label: "Video count" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "subscriber_count", label: "Subscriber count" },
];

export const THEMES: { value: Theme; label: string; preview: string }[] = [
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

export const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "library", label: "Library" },
  { id: "playback", label: "Playback" },
  { id: "ai", label: "AI" },
  { id: "system", label: "System" },
];

export const AI_SCHEDULE_OPTIONS: { value: AiSchedule; label: string; description: string }[] = [
  {
    value: "on_download",
    label: "On download",
    description:
      "Embed and enrich tags when a video finishes downloading, and queue missing search indexes when the GPU job queue is idle",
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
    description: "No automatic work — use Run now below",
  },
];

export const EMBED_MODEL_OPTIONS = [
  { value: "nomic-embed-text", label: "nomic-embed-text (default)" },
  { value: "mxbai-embed-large", label: "mxbai-embed-large" },
  { value: "all-minilm", label: "all-minilm" },
  { value: "__custom__", label: "Custom…" },
];

export const CHAT_MODEL_OPTIONS = [
  { value: "llama3.2:3b", label: "llama3.2:3b" },
  { value: "llama3.2:1b", label: "llama3.2:1b" },
  { value: "qwen2.5:3b", label: "qwen2.5:3b" },
  { value: "qwen2.5:7b", label: "qwen2.5:7b" },
  { value: "qwen2.5:14b", label: "qwen2.5:14b" },
  { value: "llama3.1:8b", label: "llama3.1:8b" },
  { value: "phi3:mini", label: "phi3:mini" },
  { value: "__custom__", label: "Custom…" },
];

export const WORKLOAD_TIP =
  "Applies with Local AI or OpenRouter. Light keeps invent samples and indexing queues " +
  "small for quieter runs. Normal is the balanced default. Heavy uses larger invent " +
  "samples, deeper subtitle context, and bigger index batches — more processing time, " +
  "better coverage on large libraries. When Local AI is used, applying a workload also " +
  "picks Ollama models based on available VRAM.";

export const VRAM_OVERRIDE_TIP =
  "When Ollama runs on another PC, Horde cannot always read that GPU. Enter its VRAM in " +
  "GB (e.g. 12 for an RTX 4070 or RX 7800 XT) so workload and model picks match Ollama. " +
  "Leave blank to autodetect: same-host probes NVIDIA, AMD (ROCm/sysfs), or Intel DRM; " +
  "remote tries Ollama’s /api/info when available.";

export const SUMMARY_LENGTH_TIP =
  "How long on-demand Watch summaries should be. Short ≈75–120 words, " +
  "medium ≈200–280, long ≈300–400 (around 350). Medium and long also pull more caption context.";

export const WORKLOAD_OPTIONS: { value: AiWorkloadProfile; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "normal", label: "Normal" },
  { value: "heavy", label: "Heavy" },
];

export const SUMMARY_LENGTH_OPTIONS: { value: AiSummaryLength; label: string }[] = [
  { value: "short", label: "Short" },
  { value: "medium", label: "Medium" },
  { value: "long", label: "Long" },
];

export const DEFAULT_AI: AiSettings = {
  enabled: true,
  provider: "ollama",
  base_url: "",
  embed_model: "nomic-embed-text",
  chat_model: "llama3.2:3b",
  openrouter_enabled: false,
  openrouter_api_key: "",
  openrouter_api_key_set: false,
  openrouter_model: "google/gemini-2.5-flash-lite",
  openrouter_scope: "specialized",
  openrouter_embed_model: "openai/text-embedding-3-small",
  ollama_prefer_embeddings: false,
  openrouter_show_costs: false,
  openrouter_weekly_budget_usd: null,
  openrouter_budget_hard_limit: false,
  schedule: "on_download",
  timer_hours: 6,
  schedule_time: "03:00",
  auto_pull_models: true,
  use_subtitles: true,
  enrich_tags: true,
  tag_rescan_days: 90,
  ai_summaries: true,
  ai_chat: true,
  summary_length: "short",
  ai_duplicates: true,
  category_min_score: 0.55,
  workload_profile: "normal",
  vram_gb: null,
  paused: false,
};

export const OPENROUTER_PRESETS = [
  {
    id: "budget",
    label: "Budget",
    model: "google/gemini-2.5-flash-lite",
  },
  {
    id: "best",
    label: "Best",
    model: "google/gemini-2.5-flash",
  },
] as const;

export const HOVER_MOTION_OPTIONS: {
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

export const NAV_INDICATOR_OPTIONS: {
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

export const TAB_STORAGE_KEY = "horde.settings.tab";
export const UPDATE_DISMISS_KEY = "horde.settings.updateDismissedSha";
