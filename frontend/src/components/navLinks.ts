import type { Permission } from "../types";
import { useAuth } from "../context/AuthContext";
import { useConnectivity, useOfflineDownloads } from "../offline/hooks";

export interface NavLinkDef {
  to: string;
  label: string;
  end: boolean;
  /** Needs the server; hidden in offline mode. */
  serverOnly?: boolean;
  /** Hidden for accounts without this permission. */
  permission?: Permission;
}

const BASE_LINKS: NavLinkDef[] = [
  { to: "/", label: "Home", end: true },
  { to: "/playlists", label: "Playlists", end: false, serverOnly: true },
  { to: "/history", label: "History", end: false, serverOnly: true },
  {
    to: "/download",
    label: "Download",
    end: false,
    serverOnly: true,
    permission: "download",
  },
  {
    to: "/import",
    label: "Import",
    end: false,
    serverOnly: true,
    permission: "download",
  },
  { to: "/settings", label: "Settings", end: false },
];

const OFFLINE_LINK: NavLinkDef = {
  to: "/offline",
  label: "Offline",
  end: false,
};

/** The primary pages this account can open now, in nav order. */
export function useNavLinks(): NavLinkDef[] {
  const { can } = useAuth();
  const net = useConnectivity();
  const offlineMode = net.status === "offline";
  const offlineSnap = useOfflineDownloads();
  // Private downloads of other accounts still earn the link: the page says
  // how to get at them.
  const hasOfflineItems =
    offlineSnap.items.length > 0 || offlineSnap.hidden.length > 0;
  return (
    hasOfflineItems || offlineMode
      ? [...BASE_LINKS.slice(0, 3), OFFLINE_LINK, ...BASE_LINKS.slice(3)]
      : BASE_LINKS
  ).filter(
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
