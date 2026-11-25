// The desktop shell end to end: the real Electron app starting the real server.
//
// Unpackaged by default (the repository's Python, `npm run build` first);
// HORDE_DESKTOP_APP=<packaged executable> runs it against an installer build.
// HORDE_DESKTOP_HEADLESS=1 runs Electron with no display at all (local runs on
// a desktop session); CI runs it under xvfb or on a real desktop instead.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
/** The YouTube helper is bundled (packaged builds) or pointed at. */
const HELPER =
  Boolean(process.env.HORDE_DESKTOP_POT_DIR) ||
  (PACKAGED !== null &&
    [
      path.join(path.dirname(PACKAGED), "resources", "pot", "server"),
      path.join(path.dirname(PACKAGED), "..", "Resources", "pot", "server"),
    ].some((dir) => fs.existsSync(path.join(dir, "horde_lifeline.ts"))));

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

interface Launch {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

const describeLaunch = (r: Launch) =>
  `exit code ${r.code}, signal ${r.signal}, output:\n${r.output.slice(-4_000)}`;

/** A second launch of the same app, as the person double-clicking again. */
async function secondLaunch(extra: string[]): Promise<Launch> {
  // The same switches as Playwright's own launch, which adds --no-sandbox on
  // Linux: without it Chromium aborts at once where unprivileged user
  // namespaces are restricted (Ubuntu 24.04, as on GitHub's runners).
  const sandbox =
    process.platform === "linux" && !extra.includes("--no-sandbox")
      ? ["--no-sandbox"]
      : [];
  const proc = spawn(ELECTRON, [...sandbox, ...appArgs(extra)], {
    env: appEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  proc.stdout.on("data", (d: Buffer) => (output += d.toString()));
  proc.stderr.on("data", (d: Buffer) => (output += d.toString()));
  const done = await Promise.race([
    new Promise<true>((resolve) => proc.once("close", () => resolve(true))),
    new Promise<false>((r) => setTimeout(() => r(false), 30_000)),
  ]);
  if (!done) {
    proc.kill("SIGKILL");
    throw new Error(`the second launch did not exit; output:\n${output}`);
  }
  return { code: proc.exitCode, signal: proc.signalCode, output };
}

async function helperPort(): Promise<number> {
  let found: number | null = null;
  await expect
    .poll(async () => {
      found = await current().evaluate(() => globalThis.__hordeTest!.potPort());
      return found;
    })
    .not.toBeNull();
  const pid = await current().evaluate(() => globalThis.__hordeTest!.potPid());
  if (pid !== null) serverPids.add(pid); // killed in afterAll if left over
  return found!;
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
  // Windows may hold a file a moment after the processes ended.
  fs.rmSync(home, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  });
});

test("the window shows the create-admin page", async () => {
  const page = await current().firstWindow({ timeout: 120_000 });
  await createAdminShown(page);
  expect(page.url()).toContain(`http://127.0.0.1:${port}/`);
});

test("the YouTube helper answers", async () => {
  test.skip(!HELPER, "no YouTube helper bundled");
  const pot = await helperPort();
  let body: { version?: unknown } = {};
  await expect
    .poll(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${pot}/ping`, {
            signal: AbortSignal.timeout(3_000),
          });
          body = (await res.json()) as { version?: unknown };
          return res.ok;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  expect(typeof body.version).toBe("string");
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
  const hidden = await secondLaunch(["--hidden"]);
  expect(hidden.code, describeLaunch(hidden)).toBe(0);
  await new Promise((r) => setTimeout(r, 2_000));
  expect(await windowCount()).toBe(0);
  // Opened again by hand: the running one shows its window.
  const shown = current().waitForEvent("window");
  const again = await secondLaunch([]);
  expect(again.code, describeLaunch(again)).toBe(0);
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
  const pot = HELPER ? await helperPort() : null;
  const proc = current().process();
  const gone = exited(proc);
  await clickTray("Quit Horde");
  await gone;
  app = null;
  expect(alive(pid)).toBe(false);
  expect(await accepts(port)).toBe(false);
  if (pot !== null) expect(await accepts(pot)).toBe(false);
});

/** What is still running, for a failure message (the app's log dies with it). */
function processTable(): string {
  try {
    if (process.platform === "win32") {
      return execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'Horde|python|deno|electron' } | Select-Object ProcessId,ParentProcessId,Name | Format-Table -AutoSize | Out-String -Width 200",
        ],
        { encoding: "utf8", timeout: 30_000 }
      );
    }
    return execFileSync("ps", ["-eo", "pid,ppid,comm"], {
      encoding: "utf8",
      timeout: 30_000,
    })
      .split("\n")
      .filter((line) => /horde|python|deno|electron|PID/i.test(line))
      .join("\n");
  } catch (err) {
    return `could not list processes: ${String(err)}`;
  }
}

test("killing the app also ends the server", async () => {
  // The server, not the window: Playwright stalls a page that the service
  // worker from the first launch controls (checked by hand: without
  // Playwright the relaunched window loads normally).
  await launch();
  const pid = await serverPid();
  await expect.poll(pingOk, { timeout: 120_000 }).toBe(true);
  const pot = HELPER ? await helperPort() : null;
  const proc = current().process();
  const gone = exited(proc);
  proc.kill("SIGKILL");
  await gone;
  app = null;
  // What matters is that the server stops answering. 30 s is its own limit
  // for a stop before it ends itself, so 60 s covers that too.
  const deadline = Date.now() + 60_000;
  while ((await accepts(port)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const report = () =>
    `server pid ${pid}, app pid ${proc.pid ?? "?"}; still running:\n${processTable()}`;
  expect(await accepts(port), `the server still answers. ${report()}`).toBe(
    false
  );
  // A pid can be reused at once on Windows, so this is checked second and
  // says what holds it.
  await expect
    .poll(() => alive(pid), { timeout: 10_000, message: report() })
    .toBe(false);
  if (pot !== null) {
    await expect.poll(() => accepts(pot), { timeout: 20_000 }).toBe(false);
  }
  // It must have stopped by itself, not through the exit of last resort
  // (which leaves every thread's stack in this file).
  const forced = path.join(home, "data", "desktop", "forced-exit.txt");
  expect(
    fs.existsSync(forced) ? fs.readFileSync(forced, "utf8") : "",
    "the server had to end itself"
  ).toBe("");
});
