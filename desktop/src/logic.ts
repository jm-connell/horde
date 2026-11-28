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
  /** The shell is stopping to install right now. */
  installing: boolean;
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
  | { kind: "report-updated"; requestId: string }
  | { kind: "report-interrupted"; requestId: string };

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
    current?: Record<string, string>;
    status?: Record<string, string>;
  },
  updater: UpdaterState
): WatcherAction {
  if (updater.installing) return { kind: "stamp" };
  const status = files.status ?? {};
  const pending = updater.pending;
  const ownPending = (id: string | undefined) =>
    Boolean(id) && pending?.requestId === id;
  // Back after installing an update this watcher started: say how it went.
  if (status.STATE === "running" && ownPending(status.REQUEST_ID)) {
    return pending!.toVersion === updater.currentVersion
      ? { kind: "report-updated", requestId: pending!.requestId! }
      : { kind: "report-failed", requestId: pending!.requestId! };
  }
  // As update_watch.sh: a run that stopped midway (the shell was killed, or
  // a file could not be written) is reported as interrupted, never left
  // "running". A request still waiting in request.env is not one of them.
  if (status.STATE === "running") {
    const id = status.REQUEST_ID ?? "";
    return {
      kind: "report-interrupted",
      requestId: REQUEST_ID.test(id) ? id : "",
    };
  }
  const taken = files.current?.REQUEST_ID ?? "";
  if (
    REQUEST_ID.test(taken) &&
    taken !== status.REQUEST_ID &&
    taken !== files.request?.REQUEST_ID &&
    !ownPending(taken)
  ) {
    return { kind: "report-interrupted", requestId: taken };
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

/** Where the server listens. Sharing needs an admin account: the status file
 * from the last run must say setup is done (desktop.json outlives a deleted
 * data folder, and on a fresh one the first visitor becomes the admin). */
export function bindHost(
  share: boolean,
  status: ServerStatus | null
): "0.0.0.0" | "127.0.0.1" {
  return share && status?.setup_required === false ? "0.0.0.0" : "127.0.0.1";
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

/** Whether a `#rrggbb` page color is dark, so the window frame around it
 * gets light text and buttons. Anything unreadable counts as dark. */
export function isDarkColor(color: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return true;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
