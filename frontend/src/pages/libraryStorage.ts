import { getItem, getJson, removeItem, setItem, setJson } from "../storage";

const FEED_LAYOUT_KEY = "horde.channelFeed.layout";
const HOME_TAB_KEY = "horde.home.tab";
const CHANNEL_URLS_KEY = "horde.channelUrls";

export type HomeTab = "library" | "recommended";

/** A saved home tab, whatever was stored ("discover" is the old Recommended+). */
export function homeTabOf(value: unknown): HomeTab {
  return value === "recommended" || value === "discover"
    ? "recommended"
    : "library";
}

/**
 * The home tab this browser saved before the choice moved to the account
 * (`Settings.homeTab`), once: it is removed as it is read. Null when none.
 */
export function takeBrowserHomeTab(): HomeTab | null {
  const stored = getItem(HOME_TAB_KEY);
  if (stored === null) return null;
  removeItem(HOME_TAB_KEY);
  return homeTabOf(stored);
}

export function loadFeedLayout(): "grid" | "list" {
  return getItem(FEED_LAYOUT_KEY) === "list" ? "list" : "grid";
}

export function saveFeedLayout(layout: "grid" | "list"): void {
  setItem(FEED_LAYOUT_KEY, layout);
}

const isStringMap = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function loadChannelUrlMap(): Record<string, string> {
  return getJson(CHANNEL_URLS_KEY, isStringMap, {});
}

export function saveChannelUrl(name: string, url: string) {
  setJson(CHANNEL_URLS_KEY, { ...loadChannelUrlMap(), [name]: url });
}

export { FEED_LAYOUT_KEY, HOME_TAB_KEY, CHANNEL_URLS_KEY };
