const FEED_LAYOUT_KEY = "horde.channelFeed.layout";
const HOME_TAB_KEY = "horde.home.tab";
const CHANNEL_URLS_KEY = "horde.channelUrls";

export type HomeTab = "library" | "recommended";

export function loadHomeTab(): HomeTab {
  try {
    return localStorage.getItem(HOME_TAB_KEY) === "recommended"
      ? "recommended"
      : "library";
  } catch {
    return "library";
  }
}

export function saveHomeTab(tab: HomeTab): void {
  try {
    localStorage.setItem(HOME_TAB_KEY, tab);
  } catch {
    /* ignore */
  }
}

export function loadFeedLayout(): "grid" | "list" {
  try {
    return localStorage.getItem(FEED_LAYOUT_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function saveFeedLayout(layout: "grid" | "list"): void {
  try {
    localStorage.setItem(FEED_LAYOUT_KEY, layout);
  } catch {
    /* ignore */
  }
}

export function loadChannelUrlMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CHANNEL_URLS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveChannelUrl(name: string, url: string) {
  try {
    const map = loadChannelUrlMap();
    map[name] = url;
    localStorage.setItem(CHANNEL_URLS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export { FEED_LAYOUT_KEY, HOME_TAB_KEY, CHANNEL_URLS_KEY };
