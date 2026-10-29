import { getItem, getJson, setItem, setJson } from "../storage";

const FEED_LAYOUT_KEY = "horde.channelFeed.layout";
const HOME_TAB_KEY = "horde.home.tab";
const CHANNEL_URLS_KEY = "horde.channelUrls";

export type HomeTab = "library" | "recommended" | "discover";

export function loadHomeTab(): HomeTab {
  const stored = getItem(HOME_TAB_KEY);
  return stored === "recommended" || stored === "discover" ? stored : "library";
}

export function saveHomeTab(tab: HomeTab): void {
  setItem(HOME_TAB_KEY, tab);
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
