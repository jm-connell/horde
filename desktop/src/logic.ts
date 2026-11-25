// Pure decisions of the shell. No Electron, no file system: everything here is
// unit tested in test/logic.test.ts, and the modules around it only do I/O.

/** `DATA_DIR/desktop/status.json`, written by the server every 5 seconds. */
export interface ServerStatus {
  written_at: string;
  pid: number;
  version: string;
  setup_required: boolean;
  busy: boolean;
  running: Record<string, number>;
  queued: number;
  last_media_at: string | null;
}

/** An update being installed, kept in desktop.json across the restart. */
export interface PendingUpdate {
  /** The "Update now" request it answers (ADR 0011), or null when idle-installed. */
  requestId: string | null;
  fromVersion: string;
  toVersion: string;
  startedAt: string;
  /** Installed by the shell, which restarts itself: whether to show the
   * window again then. Null for an install on quit (started by the person). */
  reopenWindow: boolean | null;
}

export interface UpdaterState {
  currentVersion: string;
  /** What the last update check found. */
  check: "unknown" | "checking" | "up-to-date" | "ready" | "error";
  /** The downloaded version waiting to be installed. */
  readyVersion: string | null;
  pending: PendingUpdate | null;
}

/** What the shell does this minute in the part of the ADR 0011 host watcher.
 * `LAST_SEEN` is stamped on every tick whatever the action. */
export type WatcherAction =
  | { kind: "stamp" }
  | { kind: "check" }
  | { kind: "discard-request" }
  | { kind: "start"; requestId: string; toVersion: string }
  | { kind: "report-up-to-date"; requestId: string }
  | { kind: "report-failed"; requestId: string }
  | { kind: "report-updated"; requestId: string };

export const STATUS_STALE_MS = 30_000;
export const MEDIA_QUIET_MS = 15 * 60_000;

/** Server restarts after a crash: at most `max` within `windowMs`. */
export class RestartLimiter {
  private readonly times: number[] = [];

  constructor(
    private readonly max = 3,
    private readonly windowMs = 300_000
  ) {}

  allow(now: number): boolean {
    while (this.times.length > 0 && now - this.times[0] >= this.windowMs) {
      this.times.shift();
    }
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Safe to install an update: no window, nothing running, nobody watching. */
export function isIdle(s: {
  windowOpen: boolean;
  status: ServerStatus | null;
  now: number;
}): boolean {
  if (s.windowOpen || s.status === null) return false;
  const written = timeOf(s.status.written_at);
  if (written === null || s.now - written > STATUS_STALE_MS) return false;
  if (s.status.busy) return false;
  if (Object.values(s.status.running).some((n) => n > 0)) return false;
  if (s.status.queued > 0) return false;
  const media = timeOf(s.status.last_media_at);
  if (media !== null && s.now - media < MEDIA_QUIET_MS) return false;
  return true;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// Task kinds of services/activity.py, in plain words. Several kinds share a
// phrase; the first one listed decides the order on the line.
const PHRASES: [string[], (n: number) => string][] = [
  [["download"], (n) => `Downloading ${n} ${plural(n, "video", "videos")}`],
  [["finalize", "playlist_import", "playlist_sync"], () => "Saving downloads"],
  [["sprites", "thumbnail"], () => "Making thumbnails"],
  [
    ["ffmpeg", "media", "compat", "mp4_compat", "transcode", "loudnorm"],
    () => "Preparing videos",
  ],
  [
    ["scan", "metadata_sync", "sidecars", "library"],
    () => "Updating the library",
  ],
  [["subtitles"], () => "Fetching subtitles"],
  [["comments"], () => "Fetching comments"],
  [["catalog", "feed_enrich", "index"], () => "Listing channel videos"],
  [["ask"], () => "Indexing captions"],
  [["ai", "model_pull"], () => "Working on AI search"],
];

/** The tray's status line, e.g. "Downloading 2 videos · Making thumbnails". */
export function statusLine(status: ServerStatus | null): string {
  if (status === null) return "Starting…";
  const running = { ...status.running };
  const parts: string[] = [];
  for (const [kinds, say] of PHRASES) {
    const n = kinds.reduce((sum, k) => sum + (running[k] ?? 0), 0);
    for (const k of kinds) delete running[k];
    if (n > 0) parts.push(say(n));
  }
  if (Object.values(running).some((n) => n > 0)) parts.push("Working");
  if (parts.length === 0 && status.queued > 0) {
    parts.push(
      `${status.queued} ${plural(status.queued, "task", "tasks")} waiting`
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "Idle";
}

/** The preferred port when it is free, else the next free one above it. */
export async function choosePort(
  preferred: number,
  isFree: (p: number) => Promise<boolean>
): Promise<number> {
  for (let p = preferred; p < preferred + 100 && p <= 65_535; p++) {
    if (await isFree(p)) return p;
  }
  throw new Error(`no free port between ${preferred} and ${preferred + 99}`);
}

/** `KEY=value` lines as the server reads them (update_control._read_env). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    if (key) out[key] = line.slice(at + 1).trim();
  }
  return out;
}

const REQUEST_ID = /^[0-9a-f]{32}$/;

/** The host watcher's decision for one tick (scripts/update_watch.sh). */
export function watcherAction(
  files: {
    request?: Record<string, string>;
    status?: Record<string, string>;
  },
  updater: UpdaterState
): WatcherAction {
  const status = files.status ?? {};
  const pending = updater.pending;
  // Back after installing an update this watcher started: say how it went.
  if (
    status.STATE === "running" &&
    pending?.requestId &&
    status.REQUEST_ID === pending.requestId
  ) {
    return pending.toVersion === updater.currentVersion
      ? { kind: "report-updated", requestId: pending.requestId }
      : { kind: "report-failed", requestId: pending.requestId };
  }
  const request = files.request;
  if (request === undefined) return { kind: "stamp" };
  const requestId = request.REQUEST_ID ?? "";
  if (!REQUEST_ID.test(requestId)) return { kind: "discard-request" };
  switch (updater.check) {
    case "ready":
      return updater.readyVersion
        ? { kind: "start", requestId, toVersion: updater.readyVersion }
        : { kind: "check" };
    case "up-to-date":
      return { kind: "report-up-to-date", requestId };
    case "error":
      return { kind: "report-failed", requestId };
    case "unknown":
      return { kind: "check" };
    case "checking":
      return { kind: "stamp" };
  }
}

/** `2026-11-24T10:00:00Z`, the form update_watch.sh writes. */
export function isoSeconds(now: number): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The Exec= value of a .desktop file for `file` and `args`: quoted as the
 * Desktop Entry spec asks, then escaped as a string value. */
export function desktopExec(file: string, args: string[] = []): string {
  const quote = (arg: string) =>
    `"${arg.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, "%%")}"`;
  const line = [file, ...args].map(quote).join(" ");
  return line.replace(/\\/g, "\\\\");
}
