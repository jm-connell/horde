// The Horde window. Created when asked for and destroyed on close, so no
// Chromium page stays in memory while Horde runs in the background. Horde's
// pages render data from the internet, so they get no Node access, no preload,
// and cannot navigate away from Horde's own address.
import {
  BrowserWindow,
  type Session,
  nativeTheme,
  session,
  shell,
} from "electron";
import { isDarkColor } from "./logic";

/** index.html's theme-color: the default theme's page background. */
const PAGE_COLOR = "#08090c";

const ALLOWED_PERMISSIONS = new Set([
  "fullscreen",
  "pointerLock",
  "clipboard-sanitized-write",
]);

export interface WindowHooks {
  /** Opens a link in the default browser (recorded instead under tests). */
  openExternal: (url: string) => void;
  onClosed: () => void;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Permission and attach rules for the session Horde's pages use. Once. */
export function secureSession(ses: Session = session.defaultSession): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission))
  );
  ses.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  );
}

export function createWindow(
  origin: string,
  hooks: WindowHooks
): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    title: "Horde",
    backgroundColor: PAGE_COLOR,
    show: false,
    // The menu stays out of the way (Alt shows it) and its shortcuts work.
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const wc = win.webContents;
  // The title bar takes the page's own background, so the window reads as one
  // surface. The page keeps its theme-color in step with the chosen theme.
  const paintFrame = (color: string) => {
    nativeTheme.themeSource = isDarkColor(color) ? "dark" : "light";
    if (process.platform === "win32") win.setAccentColor(color);
  };
  paintFrame(PAGE_COLOR);
  wc.on("did-change-theme-color", (_event, color) => {
    if (color) paintFrame(color);
  });
  const leave = (url: string) => {
    if (isWebUrl(url)) hooks.openExternal(url);
  };
  wc.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url, origin)) {
      void win.loadURL(url);
    } else {
      leave(url);
    }
    return { action: "deny" };
  });
  const guard = (event: Electron.Event, url: string) => {
    if (sameOrigin(url, origin)) return;
    event.preventDefault();
    leave(url);
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.on("will-attach-webview", (event) => event.preventDefault());
  win.once("ready-to-show", () => win.show());
  win.on("closed", hooks.onClosed);
  void win.loadURL(`${origin}/`);
  return win;
}

/** Open http(s) links in the person's browser; anything else is ignored. */
export function openInBrowser(url: string): void {
  if (isWebUrl(url)) void shell.openExternal(url);
}
