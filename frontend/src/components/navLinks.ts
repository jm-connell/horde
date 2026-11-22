import type { Permission } from "../types";
import { useAuth } from "../context/AuthContext";
import { useConnectivity, useOfflineDownloads } from "../offline/hooks";
import { NAV_BAR_ITEMS, NAV_BAR_LABELS, type NavBarItem } from "../navBar";

export interface NavLinkDef {
  to: string;
  label: string;
  end: boolean;
  /** Needs the server; hidden in offline mode. */
  serverOnly?: boolean;
  /** Hidden for accounts without this permission. */
  permission?: Permission;
}

const LINKS: Record<NavBarItem, Omit<NavLinkDef, "label">> = {
  home: { to: "/", end: true },
  playlists: { to: "/playlists", end: false, serverOnly: true },
  subscriptions: { to: "/subscriptions", end: false, serverOnly: true },
  history: { to: "/history", end: false, serverOnly: true },
  offline: { to: "/offline", end: false },
  download: {
    to: "/download",
    end: false,
    serverOnly: true,
    permission: "download",
  },
  import: {
    to: "/import",
    end: false,
    serverOnly: true,
    permission: "download",
  },
  settings: { to: "/settings", end: false },
};

/**
 * The primary pages this account can open now, in `order` (every page in the
 * nav's own order by default; the top bar passes the account's choice).
 */
export function useNavLinks(
  order: readonly NavBarItem[] = NAV_BAR_ITEMS
): NavLinkDef[] {
  const { can } = useAuth();
  const net = useConnectivity();
  const offlineMode = net.status === "offline";
  const offlineSnap = useOfflineDownloads();
  // Private downloads of other accounts still earn the link: the page says
  // how to get at them.
  const hasOfflineItems =
    offlineSnap.items.length > 0 || offlineSnap.hidden.length > 0;
  return order
    .filter((item) => item !== "offline" || hasOfflineItems || offlineMode)
    .map((item) => ({ ...LINKS[item], label: NAV_BAR_LABELS[item] }))
    .filter(
      (link) =>
        !(offlineMode && link.serverOnly) &&
        (!link.permission || can(link.permission))
    );
}

export function isLinkActive(
  pathname: string,
  to: string,
  end: boolean
): boolean {
  if (end) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}
