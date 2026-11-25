// The tray icon and its menu, the same items on every OS. The menu is built
// from a plain template so tests (and desktops without a tray, like GNOME)
// do not depend on a visible icon. The window's own menu offers Quit too.
import {
  Menu,
  type MenuItemConstructorOptions,
  Tray,
  nativeImage,
} from "electron";

export interface TrayState {
  statusLine: string;
  version: string;
  startAtSignIn: boolean;
  canStartAtSignIn: boolean;
  shareOnNetwork: boolean;
  /** Sharing needs an admin account: false until setup is done. */
  canShare: boolean;
  /** Addresses other devices can open while sharing is on. */
  shareAddresses: string[];
  /** "Check for updates", "Restart to update to 1.5.0", ... */
  updateLabel: string;
}

export interface TrayActions {
  openWindow(): void;
  openInBrowser(): void;
  toggleStartAtSignIn(): void;
  toggleShare(): void;
  openMediaFolder(): void;
  openLogs(): void;
  update(): void;
  about(): void;
  quit(): void;
}

export function trayTemplate(
  s: TrayState,
  a: TrayActions
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: "Open Horde", click: () => a.openWindow() },
    { label: "Open in browser", click: () => a.openInBrowser() },
    { type: "separator" },
    { label: s.statusLine, enabled: false },
    { type: "separator" },
    {
      label: "Start Horde when I sign in",
      type: "checkbox",
      checked: s.startAtSignIn,
      enabled: s.canStartAtSignIn,
      click: () => a.toggleStartAtSignIn(),
    },
    {
      label: "Share on my home network",
      type: "checkbox",
      checked: s.shareOnNetwork,
      enabled: s.canShare || s.shareOnNetwork,
      click: () => a.toggleShare(),
    },
  ];
  for (const address of s.shareOnNetwork ? s.shareAddresses : []) {
    items.push({ label: `Other devices: ${address}`, enabled: false });
  }
  items.push(
    { type: "separator" },
    { label: "Open media folder", click: () => a.openMediaFolder() },
    { label: "Open logs", click: () => a.openLogs() },
    { label: s.updateLabel, click: () => a.update() },
    { label: `About Horde ${s.version}`, click: () => a.about() },
    { type: "separator" },
    { label: "Quit Horde", click: () => a.quit() }
  );
  return items;
}

/** The tray icon, or null where the desktop has none or it failed. */
export function createTray(
  icon: string | null,
  log: (m: string) => void
): Tray | null {
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    // No display (a headless run): GTK aborts the process, uncatchably, when
    // it builds the tray's menu, so there is no tray at all.
    log("no display, so no tray icon");
    return null;
  }
  try {
    let image = icon
      ? nativeImage.createFromPath(icon)
      : nativeImage.createEmpty();
    if (!image.isEmpty()) {
      const size = process.platform === "win32" ? 16 : 22;
      image = image.resize({ width: size, height: size });
    }
    const tray = new Tray(image);
    tray.setToolTip("Horde");
    return tray;
  } catch (err) {
    log(`no tray icon: ${String(err)}`);
    return null;
  }
}

export function setTrayMenu(
  tray: Tray | null,
  template: MenuItemConstructorOptions[]
): void {
  tray?.setContextMenu(Menu.buildFromTemplate(template));
}
