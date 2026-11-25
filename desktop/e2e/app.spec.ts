// The desktop shell end to end: the real Electron app starting the real server.
//
// Unpackaged by default (the repository's Python, `npm run build` first);
// HORDE_DESKTOP_APP=<packaged executable> runs it against an installer build.
// HORDE_DESKTOP_HEADLESS=1 runs Electron with no display at all (local runs on
// a desktop session); CI runs it under xvfb or on a real desktop instead.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from "@playwright/test";

const DESKTOP = path.resolve(__dirname, "..");
const PACKAGED = process.env.HORDE_DESKTOP_APP || null;
const HEADLESS = process.env.HORDE_DESKTOP_HEADLESS === "1";
const ELECTRON: string =
  PACKAGED ??
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- in Node the electron package exports the binary's path
  (require("electron") as string);

test.describe.configure({ mode: "serial" });

let home = "";
let port = 0;
let app: ElectronApplication | null = null;
const serverPids = new Set<number>();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port: p } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(p));
    });
  });
}

function appEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    HORDE_DESKTOP_TEST: "1",
    HORDE_DESKTOP_HOME: home,
    // A seeded server that starts no network workers, on the create-admin page.
    HORDE_E2E: "1",
    HORDE_E2E_MODE: "setup",
  });
  if (HEADLESS) {
    delete env.WAYLAND_DISPLAY;
    delete env.DISPLAY;
    // No session bus: no tray icon or notification reaches the real desktop.
    env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/nonexistent/horde-e2e-bus";
  }
  return env;
}

function appArgs(extra: string[] = []): string[] {
  return [
    ...(HEADLESS ? ["--ozone-platform=headless"] : []),
    ...(PACKAGED ? [] : [DESKTOP]),
    ...extra,
  ];
}

async function launch(): Promise<ElectronApplication> {
  const launched = await electron.launch({
    executablePath: ELECTRON,
    args: appArgs(),
    env: appEnv(),
    timeout: 60_000,
  });
  app = launched;
  return launched;
}

function current(): ElectronApplication {
  if (!app) throw new Error("the app is not running");
  return app;
}

const trayMenu = () =>
  current().evaluate(() => globalThis.__hordeTest!.trayMenu());
const clickTray = (label: string) =>
  current().evaluate((_e, l) => globalThis.__hordeTest!.clickTray(l), label);
const windowCount = () =>
  current().evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
  );

async function serverPid(): Promise<number> {
  let pid: number | null = null;
  await expect
    .poll(async () => {
      pid = await current().evaluate(() => globalThis.__hordeTest!.serverPid());
      return pid;
    })
    .not.toBeNull();
  serverPids.add(pid!);
  return pid!;
}

async function pingOk(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function accepts(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port: p, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function exited(proc: ChildProcess): Promise<number | null> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(proc.exitCode);
  }
  return new Promise((resolve) => proc.once("exit", (code) => resolve(code)));
}

async function createAdminShown(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Create the admin account" })
  ).toBeVisible({ timeout: 60_000 });
}

/** A second launch of the same app, as the person double-clicking again. */
async function secondLaunch(extra: string[]): Promise<number | null> {
  const proc = spawn(ELECTRON, appArgs(extra), {
    env: appEnv(),
    stdio: "ignore",
  });
  const code = await Promise.race([
    exited(proc),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 30_000)),
  ]);
  if (code === "timeout") {
    proc.kill("SIGKILL");
    throw new Error("the second launch did not exit");
  }
  return code;
}

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "horde desktop "));
  port = await freePort();
  // A port well away from 8686 and the web suite's, and no welcome step.
  fs.writeFileSync(
    path.join(home, "desktop.json"),
    JSON.stringify({
      port,
      mediaDir: path.join(home, "media"),
      shareOnNetwork: false,
      welcomed: true,
      closeNoticeShown: false,
      pendingUpdate: null,
    })
  );
  await launch();
});

let failed = false;
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first argument
test.afterEach(({}, info) => {
  if (info.status !== info.expectedStatus) failed = true;
});

test.afterAll(async () => {
  if (failed) {
    // The shell's and the server's log say why; the folder is removed below.
    const log = path.join(home, "logs", "horde.log");
    const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    console.log(
      `--- ${log} (end) ---\n${text.split("\n").slice(-80).join("\n")}`
    );
  }
  for (const pid of serverPids) {
    if (!alive(pid)) continue;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  }
  if (app) await app.close().catch(() => undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the window shows the create-admin page", async () => {
  const page = await current().firstWindow({ timeout: 120_000 });
  await createAdminShown(page);
  expect(page.url()).toContain(`http://127.0.0.1:${port}/`);
});

test("the player's codecs are supported", async () => {
  const page = await current().firstWindow();
  const supported = await page.evaluate(() =>
    [
      'video/mp4; codecs="avc1.640028"',
      'video/mp4; codecs="av01.0.08M.08"',
      'video/webm; codecs="vp09.00.40.08"',
      'audio/mp4; codecs="mp4a.40.2"',
    ].map((t) => MediaSource.isTypeSupported(t))
  );
  expect(supported).toEqual([true, true, true, true]);
});

test("the page has no Node access", async () => {
  const page = await current().firstWindow();
  const types = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return [typeof w.require, typeof w.process, typeof w.electron];
  });
  expect(types).toEqual(["undefined", "undefined", "undefined"]);
});

test("links to other sites open outside the window", async () => {
  const page = await current().firstWindow();
  const before = page.url();
  // Clicked from the page itself: a blocked navigation never "finishes", so
  // Playwright's own click would wait for it until it times out.
  await page.evaluate(() => {
    for (const target of ["", "_blank"]) {
      const a = document.createElement("a");
      a.href = "https://example.com/";
      a.target = target;
      document.body.append(a);
      a.click();
    }
  });
  await expect
    .poll(() =>
      current().evaluate(() => globalThis.__hordeTest!.openedExternally())
    )
    .toEqual(["https://example.com/", "https://example.com/"]);
  expect(page.url()).toBe(before);
  expect(await windowCount()).toBe(1);
});

test("closing the window keeps the server; the tray opens it again", async () => {
  const page = await current().firstWindow();
  await serverPid();
  await page.close();
  await expect.poll(windowCount).toBe(0);
  expect(await pingOk()).toBe(true);
  const reopened = current().waitForEvent("window");
  await clickTray("Open Horde");
  await createAdminShown(await reopened);
});

test("a second launch exits and the first one shows its window", async () => {
  const first = await serverPid();
  const close = async () => {
    await current().evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.close())
    );
    await expect.poll(windowCount).toBe(0);
  };
  await close();
  // At sign-in (--hidden): no second server and no window.
  expect(await secondLaunch(["--hidden"])).toBe(0);
  await new Promise((r) => setTimeout(r, 2_000));
  expect(await windowCount()).toBe(0);
  // Opened again by hand: the running one shows its window.
  const shown = current().waitForEvent("window");
  expect(await secondLaunch([])).toBe(0);
  await createAdminShown(await shown);
  expect(await serverPid()).toBe(first);
  expect(await pingOk()).toBe(true);
});

test("the tray menu has every item", async () => {
  await expect
    .poll(async () => (await trayMenu()).map((i) => i.label))
    .toContain("Idle");
  const items = await trayMenu();
  const labels = items.map((i) => i.label);
  for (const label of [
    "Open Horde",
    "Open in browser",
    "Idle",
    "Start Horde when I sign in",
    "Share on my home network",
    "Open media folder",
    "Open logs",
    "Check for updates",
    "Quit Horde",
  ]) {
    expect(labels).toContain(label);
  }
  expect(labels.some((l) => /^About Horde \S+$/.test(l))).toBe(true);
  // No admin account yet, so sharing cannot be turned on.
  const share = items.find((i) => i.label === "Share on my home network");
  expect(share).toMatchObject({ enabled: false, checked: false });
});

test("Quit Horde stops the server and frees the port", async () => {
  const pid = await serverPid();
  const proc = current().process();
  const gone = exited(proc);
  await clickTray("Quit Horde");
  await gone;
  app = null;
  expect(alive(pid)).toBe(false);
  expect(await accepts(port)).toBe(false);
});

test("killing the app also ends the server", async () => {
  // The server, not the window: Playwright stalls a page that the service
  // worker from the first launch controls (checked by hand: without
  // Playwright the relaunched window loads normally).
  await launch();
  const pid = await serverPid();
  await expect.poll(pingOk, { timeout: 120_000 }).toBe(true);
  const proc = current().process();
  const gone = exited(proc);
  proc.kill("SIGKILL");
  await gone;
  app = null;
  await expect.poll(() => alive(pid), { timeout: 20_000 }).toBe(false);
  expect(await accepts(port)).toBe(false);
});
