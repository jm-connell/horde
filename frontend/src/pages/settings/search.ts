import { TABS } from "./constants";
import type { AiPane, SettingsTab } from "./types";

export interface SearchRegistryEntry {
  tab: SettingsTab;
  keywords: string;
  /** Which AI pane this entry belongs to, when tab is "ai". */
  pane?: AiPane;
}

/** Search keywords / synonyms → tab. Used for cross-tab search + auto-switch. */
export const SEARCH_REGISTRY: SearchRegistryEntry[] = [
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
      "library metadata resync thumbnails captions view counts channel catalog index max videos refresh interval youtube only youtube",
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
    keywords:
      "undownloaded channel feed show undownloaded library downloads",
  },
  {
    tab: "playback",
    keywords: "stream quality resolution 4k 1080p 720p streaming auto",
  },
  {
    tab: "playback",
    keywords: "subtitles caption size",
  },
  {
    tab: "playback",
    keywords: "sponsorblock sponsor skip ad ads advertising commercial youtube only youtube",
  },
  {
    tab: "playback",
    keywords: "playback speed speed default",
  },
  // Downloads (legacy tab, redirected to library)
  {
    tab: "library",
    keywords:
      "download count navigation badge normalize volume loudness downloads",
  },
  // AI
  {
    tab: "ai",
    pane: "providers",
    keywords:
      "ollama connection enable ai base url queue indexed features gpu vram workload light normal heavy override openrouter api key privacy",
  },
  {
    tab: "ai",
    pane: "providers",
    keywords:
      "cost costs usage billing spend budget limit threshold warn warning weekly dollar openrouter",
  },
  {
    tab: "ai",
    pane: "providers",
    keywords:
      "models embedding chat model vram auto-pull gpu",
  },
  {
    tab: "ai",
    pane: "jobs",
    keywords:
      "when to run schedule process run all recent full embeds index rebuild reindex tags categories timer automatic catch up run now queue pause resume individual steps whole library",
  },
  {
    tab: "ai",
    pane: "features",
    keywords: "features subtitles enrich tags duplicate confirmation llm category match strictness score summary summarize captions short medium long length",
  },
  // System
  {
    tab: "system",
    keywords: "documentation docs wiki manual help guide api swagger",
  },
  {
    tab: "system",
    keywords: "storage disk space library",
  },
  {
    tab: "system",
    keywords:
      "background tasks channel catalog index queue ai process metadata sync",
  },
  {
    tab: "system",
    keywords:
      "health yt-dlp ollama disk import review downloads gpu system status horde version",
  },
  {
    tab: "system",
    keywords: "update version github git pull docker compose rebuild",
  },
  {
    tab: "system",
    keywords: "resources cpu ram memory gpu vram temperature nvidia amd intel rocm",
  },
];

export function matchesQuery(
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

export function tabMatchesQuery(tabId: SettingsTab, query: string): boolean {
  if (!query) return true;
  return SEARCH_REGISTRY.some(
    (entry) => entry.tab === tabId && matchesQuery(query, entry.keywords)
  );
}

export function firstMatchingTab(query: string): SettingsTab | null {
  if (!query) return null;
  for (const t of TABS) {
    if (tabMatchesQuery(t.id, query)) return t.id;
  }
  return null;
}

export function firstMatchingAiPane(query: string): AiPane | null {
  if (!query) return null;
  for (const pane of ["providers", "features", "jobs"] as AiPane[]) {
    if (
      SEARCH_REGISTRY.some(
        (entry) =>
          entry.tab === "ai" &&
          entry.pane === pane &&
          matchesQuery(query, entry.keywords)
      )
    ) {
      return pane;
    }
  }
  return null;
}

export function resolveAiPaneParam(raw: string | null): AiPane | null {
  if (raw === "providers" || raw === "features" || raw === "jobs") return raw;
  return null;
}
