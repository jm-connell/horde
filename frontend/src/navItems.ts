/** The pages the desktop nav bar can show, in their default order. */
export const NAV_ITEMS = [
  "home",
  "playlists",
  "subscriptions",
  "history",
  "download",
  "import",
  "settings",
] as const;

export type NavItem = (typeof NAV_ITEMS)[number];

export const DEFAULT_NAV_ITEMS: NavItem[] = [...NAV_ITEMS];

/** Always shown: the way to change this list (and everything else) back. */
export const REQUIRED_NAV_ITEM: NavItem = "settings";

export const NAV_ITEM_LABELS: Record<NavItem, string> = {
  home: "Home",
  playlists: "Playlists",
  subscriptions: "Subscriptions",
  history: "History",
  download: "Download",
  import: "Import",
  settings: "Settings",
};

/** Known pages in the saved order, each once, Settings always among them;
 *  the default when nothing usable is saved. */
export function normalizeNavItems(value: unknown): NavItem[] {
  if (!Array.isArray(value)) return [...DEFAULT_NAV_ITEMS];
  const known = new Set<string>(NAV_ITEMS);
  const items = [
    ...new Set(
      value.filter((v): v is NavItem => typeof v === "string" && known.has(v))
    ),
  ];
  if (items.length === 0) return [...DEFAULT_NAV_ITEMS];
  if (!items.includes(REQUIRED_NAV_ITEM)) items.push(REQUIRED_NAV_ITEM);
  return items;
}

/** `items` with `from` moved to where `to` is (drag and drop). */
export function moveNavItem(
  items: NavItem[],
  from: NavItem,
  to: NavItem
): NavItem[] {
  const i = items.indexOf(from);
  const j = items.indexOf(to);
  if (i < 0 || j < 0 || i === j) return items;
  const next = [...items];
  next.splice(i, 1);
  next.splice(j, 0, from);
  return next;
}
