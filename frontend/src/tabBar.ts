/** The tabs the installed app's bottom island can show, in catalog order. */
export const TAB_BAR_ITEMS = [
  "home",
  "search",
  "download",
  "chat",
  "playlists",
  "history",
  "offline",
  "settings",
] as const;

export type TabBarItem = (typeof TAB_BAR_ITEMS)[number];

export const DEFAULT_TAB_BAR: TabBarItem[] = [
  "home",
  "search",
  "download",
  "chat",
];

/** More than this does not fit beside an open label on a small phone. */
export const TAB_BAR_MAX = 5;

export const TAB_BAR_LABELS: Record<TabBarItem, string> = {
  home: "Home",
  search: "Search",
  download: "Download",
  chat: "Chat",
  playlists: "Playlists",
  history: "History",
  offline: "Offline",
  settings: "Settings",
};

/** Stroke paths on a 24px grid, drawn at one weight. */
export const TAB_BAR_ICONS: Record<TabBarItem, string> = {
  home: "M4 10.2 12 4l8 6.2v8.3a1.5 1.5 0 0 1-1.5 1.5H15v-5.5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1V20H5.5A1.5 1.5 0 0 1 4 18.5z",
  search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM20 20l-4.8-4.8",
  download: "M12 4v10.5m0 0-4.5-4.5m4.5 4.5 4.5-4.5M5 19.5h14",
  chat: "M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-4.2A7.5 7.5 0 1 1 20 11.5z",
  playlists: "M4 6h16M4 12h9M4 18h9m4-4.5v6l4.5-3z",
  history: "M3.8 12a8.2 8.2 0 1 0 2.5-5.9M3.8 4.5v3.8h3.8M12 8v4l2.8 1.8",
  offline:
    "M8 3.5h8A1.5 1.5 0 0 1 17.5 5v14a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5zM12 8v6m0 0-2.5-2.5M12 14l2.5-2.5",
  settings: "M4 7h9m4 0h3M4 17h3m4 0h9M15 4.5v5M9 14.5v5",
};

/** Known tabs in the saved order, each once, at most `TAB_BAR_MAX`; the
 *  default set when nothing usable is saved. */
export function normalizeTabBarItems(value: unknown): TabBarItem[] {
  if (!Array.isArray(value)) return [...DEFAULT_TAB_BAR];
  const known = new Set<string>(TAB_BAR_ITEMS);
  const items = [
    ...new Set(
      value.filter(
        (v): v is TabBarItem => typeof v === "string" && known.has(v)
      )
    ),
  ].slice(0, TAB_BAR_MAX);
  return items.length > 0 ? items : [...DEFAULT_TAB_BAR];
}
