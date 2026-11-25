// Start at sign-in with the OS's own mechanism, so it shows up in Task
// Manager's Startup apps and macOS Login Items and a choice made there is
// respected: the shell only changes it when the person asks. On Linux the
// AppImage also gives itself a menu entry and an icon. Never touched under
// HORDE_DESKTOP_HOME or tests, which must not change the real account.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { desktopExec } from "./logic";

export const HIDDEN_ARG = "--hidden";

function sandboxed(): boolean {
  return (
    process.env.HORDE_DESKTOP_TEST === "1" ||
    Boolean(process.env.HORDE_DESKTOP_HOME)
  );
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function dataHome(): string {
  return (
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  );
}

const autostartFile = () =>
  path.join(configHome(), "autostart", "horde.desktop");

/** The AppImage file on Linux; null when not running from one. */
function appImage(): string | null {
  return process.env.APPIMAGE || null;
}

function desktopEntry(file: string, args: string[], extra: string[]): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Horde",
    "Comment=Your video library",
    `Exec=${desktopExec(file, args)}`,
    "Icon=horde",
    "Terminal=false",
    "Categories=AudioVideo;Video;",
    ...extra,
    "",
  ].join("\n");
}

/** Whether start at sign-in can be changed here at all. */
export function autostartSupported(): boolean {
  if (sandboxed()) return false;
  if (process.platform === "linux") return appImage() !== null;
  return app.isPackaged;
}

/** An autostart entry switched off in the desktop's own settings. */
function linuxEntryOn(file: string): boolean {
  try {
    const text = readFileSync(file, "utf8");
    return !/^(Hidden=true|X-GNOME-Autostart-enabled=false)\s*$/m.test(text);
  } catch {
    return false; // no entry
  }
}

export function autostartEnabled(): boolean {
  if (!autostartSupported()) return false;
  if (process.platform === "linux") return linuxEntryOn(autostartFile());
  const settings = app.getLoginItemSettings({ args: [HIDDEN_ARG] });
  // Windows: false too when the person turned Horde off in Task Manager's
  // Startup apps, which openAtLogin alone does not show.
  return process.platform === "win32"
    ? settings.executableWillLaunchAtLogin
    : settings.openAtLogin;
}

export function setAutostart(on: boolean): void {
  if (!autostartSupported()) return;
  if (process.platform === "linux") {
    const file = autostartFile();
    const image = appImage();
    if (on && image) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        desktopEntry(image, [HIDDEN_ARG], ["X-GNOME-Autostart-enabled=true"])
      );
    } else {
      rmSync(file, { force: true });
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_ARG] });
}

/** Started by the sign-in item: no window, and the server waits a little. */
export function startedHidden(argv: string[]): boolean {
  if (argv.includes(HIDDEN_ARG)) return true;
  // macOS login items cannot pass arguments; the OS says how it opened us.
  return (
    process.platform === "darwin" &&
    app.isPackaged &&
    app.getLoginItemSettings().wasOpenedAtLogin === true
  );
}

/**
 * Linux AppImage: write the menu entry and icon, and point an existing
 * autostart entry at where the file is now (it may have been moved).
 */
export function registerLinuxApp(
  icon: string | null,
  log: (m: string) => void
): void {
  const image = appImage();
  if (process.platform !== "linux" || !image || sandboxed()) return;
  try {
    const apps = path.join(dataHome(), "applications");
    mkdirSync(apps, { recursive: true });
    writeFileSync(
      path.join(apps, "horde.desktop"),
      desktopEntry(image, [], ["StartupWMClass=Horde"])
    );
    if (icon) {
      const icons = path.join(
        dataHome(),
        "icons",
        "hicolor",
        "512x512",
        "apps"
      );
      mkdirSync(icons, { recursive: true });
      copyFileSync(icon, path.join(icons, "horde.png"));
    }
    const auto = autostartFile();
    if (linuxEntryOn(auto)) {
      const want = desktopEntry(
        image,
        [HIDDEN_ARG],
        ["X-GNOME-Autostart-enabled=true"]
      );
      if (readFileSync(auto, "utf8") !== want) writeFileSync(auto, want);
    }
  } catch (err) {
    log(`could not register the menu entry: ${String(err)}`);
  }
}
