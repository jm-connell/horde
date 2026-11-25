// The Horde server as a child process: start it, hold its standard input as
// the lifeline (the server stops when it closes, also when this process dies),
// wait for /api/ping, stop it, and read the status file it writes.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { app } from "electron";
import { type ServerStatus, parseEnvFile } from "./logic";
import type { RotatingLog } from "./log";
import { bundledTool, type Paths } from "./paths";

/** How long Quit waits for a graceful stop (the stop time Compose gives). */
export const STOP_GRACE_MS = 40_000;
/** How long a start may take before it counts as failed. */
export const START_TIMEOUT_MS = 120_000;

export interface StartOptions {
  host: string;
  port: number;
  mediaDir: string;
}

export type ExitHandler = (info: {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the shell asked it to stop. */
  intentional: boolean;
}) => void;

export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen({ port, host, exclusive: true });
  });
}

function parseStatus(text: string): ServerStatus | null {
  const v: unknown = JSON.parse(text);
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (
    typeof s.written_at !== "string" ||
    typeof s.busy !== "boolean" ||
    typeof s.setup_required !== "boolean"
  ) {
    return null;
  }
  const running: Record<string, number> = {};
  if (typeof s.running === "object" && s.running !== null) {
    for (const [k, n] of Object.entries(s.running)) {
      if (typeof n === "number") running[k] = n;
    }
  }
  return {
    written_at: s.written_at,
    pid: typeof s.pid === "number" ? s.pid : 0,
    version: typeof s.version === "string" ? s.version : "",
    setup_required: s.setup_required,
    busy: s.busy,
    running,
    queued: typeof s.queued === "number" ? s.queued : 0,
    last_media_at: typeof s.last_media_at === "string" ? s.last_media_at : null,
  };
}

export class HordeServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private exited: Promise<void> = Promise.resolve();
  port = 0;

  constructor(
    private readonly paths: Paths,
    private readonly log: RotatingLog,
    private readonly onExit: ExitHandler
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null;
  }

  private env(opts: StartOptions): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATA_DIR: this.paths.dataDir,
      DOWNLOADS_DIR: opts.mediaDir,
      HOST: opts.host,
      PORT: String(opts.port),
      HORDE_RUNTIME: "desktop",
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
    };
    const ffmpeg = bundledTool(this.paths, "ffmpeg");
    if (ffmpeg) env.FFMPEG_BIN = ffmpeg;
    const deno = bundledTool(this.paths, "deno");
    if (deno) env.YTDLP_JS_RUNTIME = `deno:${deno}`;
    if (this.paths.frontendDir && !env.HORDE_FRONTEND_DIR) {
      env.HORDE_FRONTEND_DIR = this.paths.frontendDir;
    }
    if (app.isPackaged) {
      // The bundled Python must not pick up a Python the person installed.
      delete env.PYTHONHOME;
      delete env.PYTHONPATH;
      env.PYTHONNOUSERSITE = "1";
      env.HORDE_VERSION = app.getVersion();
      const buildInfo = path.join(this.paths.backendDir, "BUILD_INFO");
      if (existsSync(buildInfo)) {
        env.BUILD_INFO_FILE = buildInfo;
        // The commit the app was built from, for bug reports.
        const sha = parseEnvFile(readFileSync(buildInfo, "utf8")).git_sha;
        if (sha) env.HORDE_GIT_SHA = sha;
      }
    }
    return env;
  }

  /** Spawn the server. Resolves once it is spawned, not when it is healthy. */
  start(opts: StartOptions): void {
    if (this.child) throw new Error("the server is already running");
    mkdirSync(this.paths.dataDir, { recursive: true });
    mkdirSync(opts.mediaDir, { recursive: true });
    this.port = opts.port;
    this.stopping = false;
    this.log.shell(
      `starting the server on ${opts.host}:${opts.port} with ${this.paths.python}`
    );
    const child = spawn(this.paths.python, ["-m", "app.desktop_entry"], {
      cwd: this.paths.backendDir,
      env: this.env(opts),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // Own process group on POSIX, so a stop can end ffmpeg children too.
      // On Windows `detached` would open a console; taskkill /T does the tree.
      detached: process.platform !== "win32",
    });
    this.child = child;
    child.stdin.on("error", (err) =>
      this.log.shell(`lifeline: ${String(err)}`)
    );
    for (const stream of [child.stdout, child.stderr]) {
      readline
        .createInterface({ input: stream, crlfDelay: Infinity })
        .on("line", (line) => this.log.server(line));
    }
    this.exited = new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        this.log.shell(
          `the server exited (code ${code ?? "none"}, signal ${signal ?? "none"})`
        );
        if (this.child === child) this.child = null;
        const intentional = this.stopping;
        resolve();
        this.onExit({ code, signal, intentional });
      };
      child.once("error", (err) => {
        this.log.shell(`could not start the server: ${String(err)}`);
        finish(null, null);
      });
      child.once("exit", finish);
    });
  }

  /** Poll /api/ping until it answers, the server exits, or time runs out. */
  async waitHealthy(timeoutMs = START_TIMEOUT_MS): Promise<boolean> {
    const child = this.child;
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${this.port}/api/ping`;
    while (Date.now() < deadline && this.child === child && child !== null) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return true;
      } catch {
        // Not listening yet; keep polling until the deadline.
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  /** Close the lifeline, wait for a graceful exit, then end the whole tree. */
  async stop(graceMs = STOP_GRACE_MS): Promise<void> {
    const child = this.child;
    if (!child || child.pid === undefined) return;
    const pid = child.pid;
    this.stopping = true;
    this.log.shell("stopping the server");
    child.stdin.end();
    const graceful = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), graceMs)),
    ]);
    if (!graceful)
      this.log.shell("the server did not stop in time; killing it");
    // Also after a graceful exit: nothing of its process group may stay behind.
    await killTree(pid, graceful);
    await this.exited;
  }

  /** `DATA_DIR/desktop/status.json`, or null when missing or unreadable. */
  readStatus(): ServerStatus | null {
    const file = path.join(this.paths.dataDir, "desktop", "status.json");
    try {
      return parseStatus(readFileSync(file, "utf8"));
    } catch {
      // Missing before the first write, or caught mid-replace: no status yet.
      return null;
    }
  }
}

function killTree(pid: number, leaderGone: boolean): Promise<void> {
  if (process.platform === "win32") {
    if (leaderGone) return Promise.resolve();
    return new Promise((resolve) => {
      const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      tk.once("error", () => resolve());
      tk.once("exit", () => resolve());
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: the group is already empty.
    if (!leaderGone) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  return Promise.resolve();
}
