// The YouTube helper (bgutil-ytdlp-pot-provider's HTTP server), run by the
// bundled deno on a loopback port. Like the server, it holds a pipe on its
// standard input and exits when that closes (pot/horde_lifeline.ts), so it
// never outlives the app. It is optional: if it cannot run, Horde still
// downloads, only meeting YouTube's checks sooner, so failures are logged and
// never shown.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { RestartLimiter } from "./logic";
import type { RotatingLog } from "./log";
import { bundledTool, type Paths } from "./paths";

const STOP_GRACE_MS = 5_000;

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export class PotHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private stopping = false;
  private started = false;
  private readonly limiter = new RestartLimiter();
  /** Chosen once per app run, so the server's helper address stays valid. */
  port: number | null = null;

  constructor(
    private readonly paths: Paths,
    private readonly log: RotatingLog,
    private readonly denoDir: string
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** The address for the server (YTDLP_POT_BASE_URL), or null without one. */
  get url(): string | null {
    return this.started && this.port !== null
      ? `http://127.0.0.1:${this.port}`
      : null;
  }

  /** Start the helper when it is bundled; never throws. */
  async start(): Promise<void> {
    if (this.child) return;
    const dir = this.paths.potServerDir;
    const deno = bundledTool(this.paths, "deno");
    if (!dir || !deno) {
      if (dir) this.log.shell("helper: no bundled deno, so no YouTube helper");
      return;
    }
    try {
      if (this.port === null) this.port = await freeLoopbackPort();
      mkdirSync(this.denoDir, { recursive: true });
      this.spawn(deno, dir, this.port);
    } catch (err) {
      this.log.shell(`helper: could not start: ${String(err)}`);
    }
  }

  private spawn(deno: string, dir: string, port: number): void {
    this.stopping = false;
    this.log.shell(`helper: starting the YouTube helper on port ${port}`);
    const child = spawn(
      deno,
      [
        "run",
        "--cached-only",
        "--allow-env",
        "--allow-net",
        "--allow-ffi=.",
        "--allow-read=.",
        "../horde_lifeline.ts",
        "--port",
        String(port),
      ],
      {
        cwd: path.join(dir, "node_modules"),
        env: {
          ...process.env,
          DENO_DIR: this.denoDir,
          DENO_NO_UPDATE_CHECK: "1",
          DENO_NO_PROMPT: "1",
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      }
    );
    this.child = child;
    this.started = true;
    child.stdin.on("error", (err) =>
      this.log.shell(`helper: lifeline: ${String(err)}`)
    );
    for (const stream of [child.stdout, child.stderr]) {
      readline
        .createInterface({ input: stream, crlfDelay: Infinity })
        .on("line", (line) => this.log.server(`[helper] ${line}`));
    }
    this.exited = new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        if (this.child === child) this.child = null;
        this.log.shell(
          `helper: exited (code ${code ?? "none"}, signal ${signal ?? "none"})`
        );
        resolve();
        if (!this.stopping) this.restart(deno, dir, port);
      };
      child.once("error", (err) => {
        this.log.shell(`helper: could not start: ${String(err)}`);
        finish(null, null);
      });
      child.once("exit", finish);
    });
  }

  private restart(deno: string, dir: string, port: number): void {
    if (!this.limiter.allow(Date.now())) {
      this.log.shell(
        "helper: stopped 3 times in 5 minutes; Horde runs without it"
      );
      return;
    }
    // A moment's pause, so a port still held by the old process is released.
    setTimeout(() => {
      if (this.child || this.stopping) return;
      try {
        this.spawn(deno, dir, port);
      } catch (err) {
        this.log.shell(`helper: could not restart: ${String(err)}`);
      }
    }, 1_000);
  }

  /** Close the lifeline, wait up to 5 seconds, then kill it. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const graceful = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), STOP_GRACE_MS)),
    ]);
    if (!graceful) {
      this.log.shell("helper: did not stop in time; killing it");
      child.kill("SIGKILL");
      await this.exited;
    }
  }
}
