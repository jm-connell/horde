// Updates from GitHub Releases through electron-updater. Windows and Linux
// download in the background and install on quit or when Horde is idle; macOS
// (unsigned) only says a new version exists. On Windows and Linux the shell
// also plays the host watcher of ADR 0011, so "Update now" in Settings works.
// Skipped entirely under tests and when not packaged.
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { app, dialog } from "electron";
import type { AppUpdater } from "electron-updater";
import {
  type PendingUpdate,
  type UpdaterState,
  isoSeconds,
  parseEnvFile,
  watcherAction,
} from "./logic";

export const RELEASES_URL = "https://github.com/jm-connell/horde/releases";
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const TICK_MS = 60_000;
/** A check older than this is redone before answering an "Update now". */
const CHECK_FRESH_MS = 2 * 60_000;
const MAX_FILE = 64 * 1024;

export interface UpdaterHost {
  log(message: string): void;
  dataDir: string;
  pending(): PendingUpdate | null;
  setPending(p: PendingUpdate | null): void;
  /** Window closed, nothing running, nobody watching (logic.isIdle). */
  idle(): boolean;
  windowOpen(): boolean;
  /** The server answers: only then is an update's outcome known. */
  serverReady(): boolean;
  /** Stop the server and let the app quit without asking. */
  prepareInstall(): Promise<void>;
  refresh(): void;
  openExternal(url: string): void;
  notify(title: string, body: string): void;
}

export function updaterEnabled(): boolean {
  return process.env.HORDE_DESKTOP_TEST !== "1" && app.isPackaged;
}

export class Updater {
  private updater: AppUpdater | null = null;
  private check: UpdaterState["check"] = "unknown";
  private checkedAt = 0;
  private readyVersion: string | null = null;
  private availableVersion: string | null = null;
  private installing = false;
  private manualCheck = false;
  private readonly mac = process.platform === "darwin";

  constructor(private readonly host: UpdaterHost) {}

  get active(): boolean {
    return this.updater !== null;
  }

  async start(): Promise<void> {
    if (!updaterEnabled()) return;
    const { autoUpdater } = await import("electron-updater");
    const log = this.host.log;
    autoUpdater.logger = {
      info: (m?: unknown) => log(`updater: ${String(m)}`),
      warn: (m?: unknown) => log(`updater: ${String(m)}`),
      error: (m?: unknown) => log(`updater: ${String(m)}`),
    };
    autoUpdater.autoDownload = !this.mac;
    autoUpdater.autoInstallOnAppQuit = !this.mac;
    autoUpdater.on("checking-for-update", () => this.setCheck("checking"));
    autoUpdater.on("update-not-available", () => {
      this.setCheck("up-to-date");
      if (this.manualCheck) {
        this.manualCheck = false;
        void dialog.showMessageBox({
          message: `Horde ${app.getVersion()} is up to date.`,
        });
      }
    });
    autoUpdater.on("update-available", (info) => {
      this.manualCheck = false;
      if (this.mac) {
        this.availableVersion = info.version;
        this.setCheck("up-to-date");
      }
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.readyVersion = info.version;
      this.setCheck("ready");
      // Installed on the next quit at the latest; remember it for the notice.
      this.host.setPending({
        requestId: null,
        fromVersion: app.getVersion(),
        toVersion: info.version,
        startedAt: isoSeconds(Date.now()),
        reopenWindow: null,
      });
    });
    autoUpdater.on("error", (err) => {
      log(`update check failed: ${String(err)}`);
      this.setCheck("error");
      if (this.manualCheck) {
        this.manualCheck = false;
        void dialog.showMessageBox({
          type: "warning",
          message: "Horde could not check for updates.",
          detail: "Check the internet connection and try again later.",
        });
      }
    });
    this.updater = autoUpdater;
    this.checkNow();
    setInterval(() => this.checkNow(), CHECK_EVERY_MS).unref();
    if (!this.mac) {
      this.tick();
      setInterval(() => this.tick(), TICK_MS).unref();
    }
  }

  private setCheck(check: UpdaterState["check"]): void {
    this.check = check;
    this.checkedAt = Date.now();
    this.host.refresh();
  }

  private checkNow(): void {
    this.updater?.checkForUpdates().catch((err: unknown) => {
      this.host.log(`update check failed: ${String(err)}`);
    });
  }

  label(): string {
    if (this.mac && this.availableVersion) return "A new version is available";
    if (this.readyVersion) return `Restart to update to ${this.readyVersion}`;
    return "Check for updates";
  }

  click(): void {
    if (!this.updater) {
      void dialog.showMessageBox({
        message: "Updates are checked by the installed app only.",
      });
      return;
    }
    if (this.mac && this.availableVersion) {
      this.host.openExternal(`${RELEASES_URL}/latest`);
    } else if (this.readyVersion) {
      void this.install(null);
    } else {
      this.manualCheck = true;
      this.checkNow();
    }
  }

  /** Stop the server and install the downloaded version now. */
  private async install(requestId: string | null): Promise<void> {
    if (!this.updater || !this.readyVersion || this.installing) return;
    this.installing = true;
    this.host.log(`installing Horde ${this.readyVersion}`);
    this.host.setPending({
      requestId,
      fromVersion: app.getVersion(),
      toVersion: this.readyVersion,
      startedAt: isoSeconds(Date.now()),
      reopenWindow: this.host.windowOpen(),
    });
    await this.host.prepareInstall();
    this.updater.quitAndInstall(true, true);
  }

  // --- ADR 0011 host watcher ------------------------------------------------

  private dir(): string {
    return path.join(this.host.dataDir, "update");
  }

  /** A control file as KEY=value pairs; undefined when missing or not a file. */
  private read(name: string): Record<string, string> | undefined {
    const file = path.join(this.dir(), name);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > MAX_FILE) return undefined;
      return parseEnvFile(readFileSync(file, "utf8"));
    } catch {
      return undefined; // missing
    }
  }

  private write(name: string, lines: Record<string, string>): void {
    const file = path.join(this.dir(), name);
    const tmp = path.join(this.dir(), `.tmp.${process.pid}.${name}`);
    const body = Object.entries(lines)
      .map(([k, v]) => `${k}=${v}\n`)
      .join("");
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, file);
  }

  private tick(): void {
    // Not before the server answers: right after an update, "updated" must
    // not be reported for a version that then fails to start.
    if (this.installing || !this.host.serverReady()) return;
    try {
      this.watch();
    } catch (err) {
      this.host.log(`update watcher: ${String(err)}`);
    }
    if (this.readyVersion && this.host.idle()) void this.install(null);
  }

  private watch(): void {
    const now = Date.now();
    mkdirSync(this.dir(), { recursive: true });
    this.write("watcher.env", { LAST_SEEN: isoSeconds(now) });
    const request = this.read("request.env");
    const status = this.read("status.env");
    const fresh = now - this.checkedAt < CHECK_FRESH_MS;
    const check =
      (this.check === "up-to-date" || this.check === "error") && !fresh
        ? "unknown"
        : this.check;
    const pending = this.host.pending();
    const action = watcherAction(
      { request, status },
      {
        currentVersion: app.getVersion(),
        check,
        readyVersion: this.readyVersion,
        pending,
      }
    );
    const take = (id: string) => {
      if (request?.REQUEST_ID === id) {
        renameSync(
          path.join(this.dir(), "request.env"),
          path.join(this.dir(), "current.env")
        );
      }
    };
    const finish = (id: string, state: string, code: number, line: string) => {
      this.write("status.env", {
        STATE: state,
        REQUEST_ID: id,
        STARTED_AT:
          status?.REQUEST_ID === id && status.STARTED_AT
            ? status.STARTED_AT
            : isoSeconds(now),
        FINISHED_AT: isoSeconds(now),
        EXIT_CODE: String(code),
      });
      writeFileSync(path.join(this.dir(), "update.log"), `${line}\n`, "utf8");
    };
    switch (action.kind) {
      case "stamp":
        return;
      case "check":
        this.checkNow();
        return;
      case "discard-request":
        this.host.log("ignoring a malformed update request");
        rmSync(path.join(this.dir(), "request.env"), { force: true });
        return;
      case "start":
        take(action.requestId);
        this.write("status.env", {
          STATE: "running",
          REQUEST_ID: action.requestId,
          STARTED_AT: isoSeconds(now),
        });
        writeFileSync(
          path.join(this.dir(), "update.log"),
          `Installing Horde ${action.toVersion}; Horde restarts by itself.\n`,
          "utf8"
        );
        void this.install(action.requestId);
        return;
      case "report-up-to-date":
        take(action.requestId);
        finish(
          action.requestId,
          "up_to_date",
          0,
          `Horde ${app.getVersion()} is the newest version.`
        );
        return;
      case "report-updated":
        finish(
          action.requestId,
          "updated",
          0,
          `Horde was updated to ${app.getVersion()}.`
        );
        this.host.setPending(null);
        return;
      case "report-failed":
        take(action.requestId);
        finish(
          action.requestId,
          "failed",
          1,
          pending?.requestId === action.requestId
            ? `Horde ${pending.toVersion} was not installed; still on ${app.getVersion()}.`
            : "Horde could not check for updates. See the Horde log."
        );
        if (pending?.requestId === action.requestId) this.host.setPending(null);
        return;
    }
  }
}
