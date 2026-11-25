// Wiring only: the pieces live in their own modules, the decisions in logic.ts.
import { mkdirSync } from "node:fs";
import os from "node:os";
import {
  type BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  type Tray,
  app,
  dialog,
  shell,
} from "electron";
import {
  HIDDEN_ARG,
  autostartEnabled,
  autostartSupported,
  registerLinuxApp,
  setAutostart,
  startedHidden,
} from "./autostart";
import { DEFAULT_PORT, loadConfig, saveConfig } from "./config";
import { closeNotice, notify, welcome } from "./firstRun";
import { RotatingLog } from "./log";
import {
  type PendingUpdate,
  RestartLimiter,
  type ServerStatus,
  choosePort,
  isIdle,
  statusLine,
} from "./logic";
import { resolvePaths } from "./paths";
import { HordeServer, isPortFree } from "./server";
import {
  type TrayActions,
  type TrayState,
  createTray,
  setTrayMenu,
  trayTemplate,
} from "./tray";
import { RELEASES_URL, Updater } from "./updater";
import { createWindow, openInBrowser, secureSession } from "./window";

interface HordeTestHook {
  trayMenu(): { label: string; enabled: boolean; checked: boolean }[];
  clickTray(label: string): void;
  serverPid(): number | null;
  port(): number;
  /** Links the shell would have opened in the default browser. */
  openedExternally(): string[];
}

declare global {
  var __hordeTest: HordeTestHook | undefined;
}

const TEST = process.env.HORDE_DESKTOP_TEST === "1";
const STATUS_POLL_MS = 5_000;
const HIDDEN_START_DELAY_MS = 30_000;

app.setName("Horde");
const paths = resolvePaths();
// Before the single-instance lock, which lives in this folder.
app.setPath("userData", paths.userData);

if (!app.requestSingleInstanceLock()) {
  // Another Horde is running; it opens its window (see "second-instance").
  app.exit(0);
} else {
  run();
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function run(): void {
  const log = new RotatingLog(paths.logsDir);
  const say = (m: string) => log.shell(m);
  const hidden = startedHidden(process.argv);
  const loaded = loadConfig(paths.configFile, paths.defaultMediaDir, say);
  const config = loaded.config;
  const save = () => {
    try {
      saveConfig(paths.configFile, config);
    } catch (err) {
      say(`could not save ${paths.configFile}: ${String(err)}`);
    }
  };

  let win: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let template: MenuItemConstructorOptions[] = [];
  let status: ServerStatus | null = null;
  let serverReady = false;
  let wantWindow = !hidden;
  let quitting = false;
  let justUpdated: PendingUpdate | null = null;
  const limiter = new RestartLimiter();
  const external: string[] = [];

  const openExternal = (url: string) => {
    say(`opening ${url} in the browser`);
    if (TEST) external.push(url);
    else openInBrowser(url);
  };

  const server = new HordeServer(paths, log, ({ intentional }) => {
    serverReady = false;
    status = null;
    refreshTray();
    if (!intentional && !quitting) void recover();
  });
  const origin = () => `http://127.0.0.1:${server.port}`;

  const updater = new Updater({
    log: say,
    dataDir: paths.dataDir,
    pending: () => config.pendingUpdate,
    setPending: (p) => {
      config.pendingUpdate = p;
      save();
    },
    idle: () =>
      isIdle({
        windowOpen: win !== null,
        status: server.running ? server.readStatus() : null,
        now: Date.now(),
      }),
    windowOpen: () => win !== null,
    serverReady: () => serverReady,
    prepareInstall: async () => {
      quitting = true;
      win?.close();
      await server.stop();
      tray?.destroy();
    },
    refresh: () => refreshTray(),
    openExternal,
    notify,
  });

  // --- window -----------------------------------------------------------------

  function showWindow(): void {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    if (!serverReady) {
      wantWindow = true; // opened as soon as the server answers
      return;
    }
    win = createWindow(origin(), {
      openExternal,
      onClosed: () => {
        win = null;
        if (!config.closeNoticeShown && !quitting && !TEST) {
          closeNotice();
          config.closeNoticeShown = true;
          save();
        }
      },
    });
  }

  // --- server -----------------------------------------------------------------

  async function startServer(): Promise<void> {
    serverReady = false;
    // The saved port keeps the address stable. If another program holds it
    // now, use the next free one for this run only rather than fail to start.
    let port = config.port;
    if (!(await isPortFree(port))) {
      port = await choosePort(port + 1, (p) => isPortFree(p));
      say(`port ${config.port} is in use; using ${port} this time`);
    }
    server.start({
      host: config.shareOnNetwork ? "0.0.0.0" : "127.0.0.1",
      port,
      mediaDir: config.mediaDir,
    });
    const mine = server.pid;
    refreshTray();
    const ok = await server.waitHealthy();
    if (!ok) {
      // Still this start's process: it hangs. Had it exited, the exit handler
      // has already restarted it (server.pid is then another process).
      if (server.running && server.pid === mine) {
        say("the server did not answer in time");
        await server.stop(10_000);
        void recover();
      }
      return;
    }
    say(`the server answers at ${origin()}`);
    serverReady = true;
    status = server.readStatus();
    if (justUpdated) {
      notify(
        "Horde was updated",
        `Horde was updated to ${justUpdated.toVersion}.`
      );
      // A request from Settings is reported (and cleared) by the watcher.
      if (justUpdated.requestId === null) {
        config.pendingUpdate = null;
        save();
      }
      justUpdated = null;
    }
    if (wantWindow) {
      wantWindow = false;
      showWindow();
    }
    refreshTray();
  }

  async function restartServer(): Promise<void> {
    await server.stop();
    await startServer();
  }

  async function recover(): Promise<void> {
    if (justUpdated) {
      await couldNotStart(justUpdated);
    } else if (limiter.allow(Date.now())) {
      say("restarting the server");
      await startServer();
    } else {
      await stoppedWorking();
    }
  }

  async function stoppedWorking(): Promise<void> {
    for (;;) {
      const { response } = await dialog.showMessageBox({
        type: "error",
        title: "Horde",
        message: "Horde stopped working",
        detail:
          "The Horde server stopped several times in a few minutes. " +
          "The log may say why.",
        buttons: ["Open logs", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return quit();
      await shell.openPath(log.file);
    }
  }

  async function couldNotStart(p: PendingUpdate): Promise<void> {
    const previous = `${RELEASES_URL}/tag/v${p.fromVersion}`;
    for (;;) {
      const { response } = await dialog.showMessageBox({
        type: "error",
        title: "Horde",
        message: `Horde ${p.toVersion} could not start`,
        detail:
          `Your videos and settings are safe. Horde backed up its database ` +
          `before the update; the backup is in the data folder:\n` +
          `${paths.dataDir}\n\n` +
          `You can download the previous version, Horde ${p.fromVersion}, ` +
          `from its release page and install it again.`,
        buttons: ["Open logs", `Download Horde ${p.fromVersion}`, "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (response === 2) return quit();
      if (response === 1) openExternal(previous);
      else await shell.openPath(log.file);
    }
  }

  // --- tray -------------------------------------------------------------------

  function trayState(): TrayState {
    return {
      statusLine: server.running ? statusLine(status) : "Not running",
      version: app.getVersion(),
      startAtSignIn: autostartEnabled(),
      canStartAtSignIn: autostartSupported(),
      shareOnNetwork: config.shareOnNetwork,
      canShare: status?.setup_required === false,
      shareAddresses: lanAddresses().map((ip) => `http://${ip}:${server.port}`),
      updateLabel: updater.label(),
    };
  }

  const actions: TrayActions = {
    openWindow: showWindow,
    openInBrowser: () => openExternal(`${origin()}/`),
    toggleStartAtSignIn: () => {
      setAutostart(!autostartEnabled());
      refreshTray();
    },
    toggleShare: () => void toggleShare(),
    openMediaFolder: () => {
      mkdirSync(config.mediaDir, { recursive: true });
      void shell.openPath(config.mediaDir);
    },
    openLogs: () => void shell.openPath(log.file),
    update: () => updater.click(),
    about: () => void about(),
    quit: () => void quit(),
  };

  function refreshTray(): void {
    template = trayTemplate(trayState(), actions);
    setTrayMenu(tray, template);
  }

  async function toggleShare(): Promise<void> {
    if (!config.shareOnNetwork) {
      if (status?.setup_required !== false) return;
      const firewall =
        process.platform === "win32"
          ? "\n\nWindows will ask whether to let Horde through the firewall. " +
            "Allow it on private networks."
          : "";
      const { response } = await dialog.showMessageBox({
        type: "question",
        title: "Horde",
        message: "Share Horde on your home network?",
        detail:
          "Phones, TVs and other computers on this network can then open " +
          "Horde and sign in with a Horde account. Horde restarts to do " +
          "this, which takes a few seconds." +
          firewall,
        buttons: ["Share", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return;
      config.shareOnNetwork = true;
    } else {
      config.shareOnNetwork = false;
    }
    save();
    await restartServer();
    if (config.shareOnNetwork && serverReady) {
      const addresses = trayState().shareAddresses;
      await dialog.showMessageBox({
        title: "Horde",
        message: "Horde is shared on your home network",
        detail:
          addresses.length > 0
            ? `Other devices can open:\n${addresses.join("\n")}`
            : "This computer has no network address right now.",
      });
    }
  }

  async function about(): Promise<void> {
    const { response } = await dialog.showMessageBox({
      title: "About Horde",
      message: `Horde ${app.getVersion()}`,
      detail:
        `Your video library.\nLicence: PolyForm Noncommercial 1.0.0\n\n` +
        `Videos: ${config.mediaDir}\nData: ${paths.dataDir}\n` +
        `Logs: ${paths.logsDir}`,
      buttons: ["OK", "Open the Horde website"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) openExternal("https://github.com/jm-connell/horde");
  }

  // --- quitting ---------------------------------------------------------------

  async function quit(): Promise<void> {
    if (quitting) return;
    const downloads = status?.running.download ?? 0;
    if (downloads > 0 && server.running && !TEST) {
      const { response } = await dialog.showMessageBox({
        type: "question",
        title: "Horde",
        message:
          downloads === 1
            ? "Horde is downloading a video."
            : `Horde is downloading ${downloads} videos.`,
        detail: "Quitting Horde stops the downloads.",
        buttons: ["Quit Horde", "Keep running"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0 || quitting) return;
    }
    quitting = true;
    say("quitting");
    win?.close();
    await server.stop();
    tray?.destroy();
    app.quit();
  }

  function appMenu(): MenuItemConstructorOptions[] {
    const quitItem: MenuItemConstructorOptions = {
      label: "Quit Horde",
      accelerator: "CmdOrCtrl+Q",
      click: () => void quit(),
    };
    const first: MenuItemConstructorOptions =
      process.platform === "darwin"
        ? {
            label: "Horde",
            submenu: [
              { label: "About Horde", click: () => void about() },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              quitItem,
            ],
          }
        : {
            label: "&Horde",
            submenu: [
              { label: "Open in browser", click: actions.openInBrowser },
              { label: "Open media folder", click: actions.openMediaFolder },
              { label: "Open logs", click: actions.openLogs },
              { label: "About Horde", click: () => void about() },
              { type: "separator" },
              { role: "close", label: "Close window" },
              quitItem,
            ],
          };
    return [
      first,
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ];
  }

  // --- events -------------------------------------------------------------------

  app.on("second-instance", (_event, argv) => {
    say("another launch; showing this one");
    if (!argv.includes(HIDDEN_ARG)) showWindow();
  });
  // Closing the window keeps Horde running in the background.
  app.on("window-all-closed", () => undefined);
  app.on("activate", () => showWindow());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void quit();
  });
  process.on("unhandledRejection", (err) =>
    say(
      `unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    )
  );

  if (TEST) {
    globalThis.__hordeTest = {
      trayMenu: () =>
        template
          .filter((i) => i.type !== "separator")
          .map((i) => ({
            label: i.label ?? "",
            enabled: i.enabled !== false,
            checked: i.checked === true,
          })),
      clickTray: (label) => {
        const item = template.find((i) => i.label === label);
        if (!item?.click) throw new Error(`no tray item "${label}"`);
        (item.click as () => void)();
      },
      serverPid: () => server.pid,
      port: () => server.port,
      openedExternally: () => [...external],
    };
  }

  void app.whenReady().then(async () => {
    say(`Horde ${app.getVersion()} starting${hidden ? " at sign-in" : ""}`);
    secureSession();
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu()));

    const pending = config.pendingUpdate;
    let relaunched = false;
    if (pending?.toVersion === app.getVersion()) {
      justUpdated = pending;
      if (pending.reopenWindow !== null) {
        // Restarted by the shell's own install, maybe while away: the window
        // comes back only if it was open, and nothing waits.
        relaunched = true;
        wantWindow = pending.reopenWindow;
        config.pendingUpdate = { ...pending, reopenWindow: null };
      }
    } else if (pending && pending.requestId === null) {
      config.pendingUpdate = null; // downloaded but never installed
    }
    if (!loaded.portSaved) {
      config.port = await choosePort(DEFAULT_PORT, (p) => isPortFree(p));
      say(`using port ${config.port}`);
    }
    if (!config.welcomed && !TEST) {
      const answer = await welcome(config.mediaDir, autostartSupported());
      config.mediaDir = answer.mediaDir;
      if (autostartSupported()) setAutostart(answer.startAtSignIn);
      config.welcomed = true;
    }
    save();
    registerLinuxApp(paths.icon, say);

    tray = createTray(paths.icon, say);
    if (process.platform === "win32") tray?.on("click", showWindow);
    refreshTray();
    setInterval(() => {
      const before = `${statusLine(status)}|${status?.setup_required}`;
      status = server.running ? server.readStatus() : null;
      // Rebuilding the menu closes it on some desktops: only on a change.
      if (`${statusLine(status)}|${status?.setup_required}` !== before) {
        refreshTray();
      }
    }, STATUS_POLL_MS);

    updater.start().catch((err: unknown) => say(`updater: ${String(err)}`));

    if (hidden && !TEST && !relaunched) {
      // Started at sign-in: let everything else start first.
      await new Promise((r) => setTimeout(r, HIDDEN_START_DELAY_MS));
    }
    await startServer();
  });
}
