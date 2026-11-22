/** The pages the top bar can link to on a wider screen, in its default order. */
export const NAV_BAR_ITEMS = [
  "home",
  "playlists",
  "subscriptions",
  "history",
  "offline",
  "download",
  "import",
  "settings",
] as const;

export type NavBarItem = (typeof NAV_BAR_ITEMS)[number];

export const DEFAULT_NAV_BAR: NavBarItem[] = [...NAV_BAR_ITEMS];

/** Always in the bar: on a wider screen nothing else leads to Settings. */
export const NAV_BAR_REQUIRED: NavBarItem = "settings";

export const NAV_BAR_LABELS: Record<NavBarItem, string> = {
  home: "Home",
  playlists: "Playlists",
  subscriptions: "Subscriptions",
  history: "History",
  offline: "Offline",
  download: "Download",
  import: "Import",
  settings: "Settings",
};

/** Known pages in the saved order, each once, with Settings always kept; the
 *  default set when nothing was saved. */
export function normalizeNavBarItems(value: unknown): NavBarItem[] {
  if (!Array.isArray(value)) return [...DEFAULT_NAV_BAR];
  const known = new Set<string>(NAV_BAR_ITEMS);
  const items = [
    ...new Set(
      value.filter(
        (v): v is NavBarItem => typeof v === "string" && known.has(v)
      )
    ),
  ];
  return items.includes(NAV_BAR_REQUIRED)
    ? items
    : [...items, NAV_BAR_REQUIRED];
}
