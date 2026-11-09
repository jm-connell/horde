import type { Permission } from "../types";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../hooks/useSettings";
import type { NavItem } from "../navItems";
import { useConnectivity, useOfflineDownloads } from "../offline/hooks";

export interface NavLinkDef {
  /** Its name in the nav bar setting (none for Offline, which comes and goes). */
  id?: NavItem;
  to: string;
  label: string;
  end: boolean;
  /** Needs the server; hidden in offline mode. */
  serverOnly?: boolean;
  /** Hidden for accounts without this permission. */
  permission?: Permission;
}

const BASE_LINKS: NavLinkDef[] = [
  { id: "home", to: "/", label: "Home", end: true },
  {
    id: "playlists",
    to: "/playlists",
    label: "Playlists",
    end: false,
    serverOnly: true,
  },
  {
    id: "subscriptions",
    to: "/subscriptions",
    label: "Subscriptions",
    end: false,
    serverOnly: true,
  },
  {
    id: "history",
    to: "/history",
    label: "History",
    end: false,
    serverOnly: true,
  },
  {
    id: "download",
    to: "/download",
    label: "Download",
    end: false,
    serverOnly: true,
    permission: "download",
  },
  {
    id: "import",
    to: "/import",
    label: "Import",
    end: false,
    serverOnly: true,
    permission: "download",
  },
  { id: "settings", to: "/settings", label: "Settings", end: false },
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
      ? [...BASE_LINKS.slice(0, 4), OFFLINE_LINK, ...BASE_LINKS.slice(4)]
      : BASE_LINKS
  ).filter(
    (link) =>
      !(offlineMode && link.serverOnly) &&
      (!link.permission || can(link.permission))
  );
}

/**
 * The nav bar's links: those this account can open now, in the order and
 * with the pages chosen in Settings (Offline, when it shows, before Settings
 * or at the end).
 */
export function useNavBarLinks(): NavLinkDef[] {
  const links = useNavLinks();
  const [settings] = useSettings();
  const byId = new Map(
    links.flatMap((l) => (l.id ? [[l.id, l] as const] : []))
  );
  const out = settings.navItems.flatMap((id) => {
    const link = byId.get(id);
    return link ? [link] : [];
  });
  const offline = links.find((l) => !l.id);
  if (offline) {
    const at = out.findIndex((l) => l.id === "settings");
    out.splice(at < 0 ? out.length : at, 0, offline);
  }
  return out;
}

export function isLinkActive(
  pathname: string,
  to: string,
  end: boolean
): boolean {
  if (end) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}
