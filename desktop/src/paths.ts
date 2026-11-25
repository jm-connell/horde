// Where things are: per-OS folders, and the bundled server either from the
// packaged app's resources or, unpackaged, from this repository (overridable
// through the HORDE_DESKTOP_* variables for development and tests).
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

export interface Paths {
  dataDir: string;
  logsDir: string;
  configFile: string;
  defaultMediaDir: string;
  userData: string;
  python: string;
  backendDir: string;
  /** ffmpeg, ffprobe and deno; null when not bundled (development). */
  binDir: string | null;
  /** The YouTube helper's `server` folder (bgutil-ytdlp-pot-provider with
   * horde_lifeline.ts); null when it is not bundled. */
  potServerDir: string | null;
  /** The built web UI when it is not in `backendDir/static`. */
  frontendDir: string | null;
  icon: string | null;
}

const exe = (name: string) =>
  process.platform === "win32" ? `${name}.exe` : name;

function folders(): Pick<
  Paths,
  "dataDir" | "logsDir" | "configFile" | "defaultMediaDir" | "userData"
> {
  const home = process.env.HORDE_DESKTOP_HOME;
  if (home) {
    return {
      dataDir: path.join(home, "data"),
      logsDir: path.join(home, "logs"),
      configFile: path.join(home, "desktop.json"),
      defaultMediaDir: path.join(home, "media"),
      userData: path.join(home, "shell"),
    };
  }
  const user = os.homedir();
  const media = path.join(app.getPath("videos"), "Horde");
  if (process.platform === "win32") {
    const base = path.join(
      process.env.LOCALAPPDATA || path.join(user, "AppData", "Local"),
      "Horde"
    );
    return {
      dataDir: path.join(base, "data"),
      logsDir: path.join(base, "logs"),
      configFile: path.join(base, "desktop.json"),
      defaultMediaDir: media,
      userData: path.join(base, "shell"),
    };
  }
  if (process.platform === "darwin") {
    const base = path.join(user, "Library", "Application Support", "Horde");
    return {
      dataDir: path.join(base, "data"),
      logsDir: path.join(user, "Library", "Logs", "Horde"),
      configFile: path.join(base, "desktop.json"),
      defaultMediaDir: media,
      userData: path.join(base, "shell"),
    };
  }
  const dataHome =
    process.env.XDG_DATA_HOME || path.join(user, ".local", "share");
  const stateHome =
    process.env.XDG_STATE_HOME || path.join(user, ".local", "state");
  return {
    dataDir: path.join(dataHome, "horde", "data"),
    logsDir: path.join(stateHome, "horde", "logs"),
    configFile: path.join(dataHome, "horde", "desktop.json"),
    defaultMediaDir: media,
    userData: app.getPath("userData"),
  };
}

function firstExisting(candidates: string[]): string | null {
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function resolvePaths(): Paths {
  const env = process.env;
  let python: string;
  let backendDir: string;
  let binDir: string | null;
  let frontendDir: string | null = null;
  let potServerDir: string | null = null;
  if (app.isPackaged) {
    const res = process.resourcesPath;
    python =
      process.platform === "win32"
        ? path.join(res, "python", "python.exe")
        : path.join(res, "python", "bin", "python3");
    backendDir = path.join(res, "backend");
    binDir = path.join(res, "bin");
    potServerDir = path.join(res, "pot", "server");
  } else {
    // desktop/ is the app path; the repository is its parent.
    const repo = path.resolve(app.getAppPath(), "..");
    python =
      firstExisting(
        process.platform === "win32"
          ? [path.join(repo, ".venv", "Scripts", "python.exe")]
          : [path.join(repo, ".venv", "bin", "python")]
      ) ?? (process.platform === "win32" ? "python" : "python3");
    backendDir = path.join(repo, "backend");
    binDir = null;
    const dist = path.join(repo, "frontend", "dist");
    if (existsSync(path.join(dist, "index.html"))) frontendDir = dist;
  }
  if (env.HORDE_DESKTOP_PYTHON) python = env.HORDE_DESKTOP_PYTHON;
  if (env.HORDE_DESKTOP_BACKEND_DIR) backendDir = env.HORDE_DESKTOP_BACKEND_DIR;
  if (env.HORDE_DESKTOP_BIN_DIR) binDir = env.HORDE_DESKTOP_BIN_DIR;
  if (env.HORDE_DESKTOP_POT_DIR) potServerDir = env.HORDE_DESKTOP_POT_DIR;
  if (
    potServerDir &&
    !existsSync(path.join(potServerDir, "horde_lifeline.ts"))
  ) {
    potServerDir = null;
  }
  const icon = firstExisting([
    path.join(app.getAppPath(), "assets", "icon.png"),
    path.join(backendDir, "static", "icon-192.png"),
    path.join(app.getAppPath(), "..", "frontend", "public", "icon-192.png"),
  ]);
  return {
    ...folders(),
    python,
    backendDir,
    binDir,
    potServerDir,
    frontendDir,
    icon,
  };
}

/** A bundled tool, or null when it is not there. */
export function bundledTool(paths: Paths, name: string): string | null {
  if (!paths.binDir) return null;
  const file = path.join(paths.binDir, exe(name));
  return existsSync(file) ? file : null;
}
