import { describe, expect, it } from "vitest";
import {
  RestartLimiter,
  bindHost,
  choosePort,
  desktopExec,
  isIdle,
  isoSeconds,
  parseEnvFile,
  statusLine,
  watcherAction,
  type ServerStatus,
  type UpdaterState,
} from "../src/logic";

const NOW = Date.parse("2026-11-24T10:00:00Z");
const MIN = 60_000;

function status(over: Partial<ServerStatus> = {}): ServerStatus {
  return {
    written_at: new Date(NOW - 2_000).toISOString(),
    pid: 1,
    version: "1.4.2",
    setup_required: false,
    busy: false,
    running: {},
    queued: 0,
    last_media_at: null,
    ...over,
  };
}

describe("RestartLimiter", () => {
  it("allows 3 restarts in 5 minutes, refuses the 4th, then allows again", () => {
    const limiter = new RestartLimiter();
    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(1 * MIN)).toBe(true);
    expect(limiter.allow(2 * MIN)).toBe(true);
    expect(limiter.allow(3 * MIN)).toBe(false);
    expect(limiter.allow(5 * MIN)).toBe(true);
  });
});

describe("isIdle", () => {
  const idle = { windowOpen: false, status: status(), now: NOW };

  it("is true when nothing runs and nobody watched for 15 minutes", () => {
    expect(isIdle(idle)).toBe(true);
    const quiet = new Date(NOW - 15 * MIN).toISOString();
    expect(isIdle({ ...idle, status: status({ last_media_at: quiet }) })).toBe(
      true
    );
  });

  it("is false for each reason", () => {
    const recent = new Date(NOW - 15 * MIN + 1_000).toISOString();
    const stale = new Date(NOW - 31_000).toISOString();
    expect(isIdle({ ...idle, windowOpen: true })).toBe(false);
    expect(isIdle({ ...idle, status: null })).toBe(false);
    expect(isIdle({ ...idle, status: status({ written_at: stale }) })).toBe(
      false
    );
    expect(isIdle({ ...idle, status: status({ busy: true }) })).toBe(false);
    expect(
      isIdle({ ...idle, status: status({ running: { download: 1 } }) })
    ).toBe(false);
    expect(isIdle({ ...idle, status: status({ queued: 2 }) })).toBe(false);
    expect(isIdle({ ...idle, status: status({ last_media_at: recent }) })).toBe(
      false
    );
  });
});

describe("statusLine", () => {
  it("says what the server is doing in plain words", () => {
    expect(statusLine(null)).toBe("Starting…");
    expect(statusLine(status())).toBe("Idle");
    expect(
      statusLine(status({ busy: true, running: { download: 2, sprites: 1 } }))
    ).toBe("Downloading 2 videos · Making thumbnails");
    expect(statusLine(status({ busy: true, running: { download: 1 } }))).toBe(
      "Downloading 1 video"
    );
    expect(statusLine(status({ busy: true, queued: 3 }))).toBe(
      "3 tasks waiting"
    );
  });
});

describe("choosePort", () => {
  it("returns 8686 when free and the next free port when not", async () => {
    expect(await choosePort(8686, async () => true)).toBe(8686);
    const taken = new Set([8686, 8687]);
    expect(await choosePort(8686, async (p) => !taken.has(p))).toBe(8688);
  });
});

describe("parseEnvFile", () => {
  it("reads KEY=value lines and ignores lines without =", () => {
    expect(
      parseEnvFile("STATE=running\r\nnot a line\n=x\nREQUEST_ID = abc=d \n")
    ).toEqual({ STATE: "running", REQUEST_ID: "abc=d" });
  });
});

describe("watcherAction", () => {
  const id = "0123456789abcdef0123456789abcdef";
  const base: UpdaterState = {
    currentVersion: "1.4.2",
    check: "up-to-date",
    readyVersion: null,
    pending: null,
    installing: false,
  };
  const pending = {
    requestId: id,
    fromVersion: "1.4.2",
    toVersion: "1.5.0",
    startedAt: "2026-11-24T09:59:00Z",
    reopenWindow: true,
  };
  const running = { STATE: "running", REQUEST_ID: id };

  it("only stamps when nothing is asked", () => {
    expect(watcherAction({}, base)).toEqual({ kind: "stamp" });
  });

  it("starts an update that is downloaded", () => {
    expect(
      watcherAction(
        { request: { REQUEST_ID: id } },
        { ...base, check: "ready", readyVersion: "1.5.0" }
      )
    ).toEqual({ kind: "start", requestId: id, toVersion: "1.5.0" });
  });

  it("reports up to date, a failed check, and asks to check first", () => {
    const request = { REQUEST_ID: id };
    expect(watcherAction({ request }, base)).toEqual({
      kind: "report-up-to-date",
      requestId: id,
    });
    expect(watcherAction({ request }, { ...base, check: "error" })).toEqual({
      kind: "report-failed",
      requestId: id,
    });
    expect(watcherAction({ request }, { ...base, check: "unknown" })).toEqual({
      kind: "check",
    });
    expect(
      watcherAction({ request: { REQUEST_ID: "../x" } }, base).kind
    ).toEqual("discard-request");
  });

  it("reports the outcome after the restart", () => {
    expect(
      watcherAction(
        { status: running },
        { ...base, currentVersion: "1.5.0", pending }
      )
    ).toEqual({ kind: "report-updated", requestId: id });
    expect(watcherAction({ status: running }, { ...base, pending })).toEqual({
      kind: "report-failed",
      requestId: id,
    });
  });
});

describe("watcherAction, interrupted runs", () => {
  const id = "0123456789abcdef0123456789abcdef";
  const other = "fedcba9876543210fedcba9876543210";
  const base: UpdaterState = {
    currentVersion: "1.4.2",
    check: "ready",
    readyVersion: "1.5.0",
    pending: null,
    installing: false,
  };

  it("reports a running state nobody is handling as interrupted", () => {
    expect(
      watcherAction({ status: { STATE: "running", REQUEST_ID: id } }, base)
    ).toEqual({ kind: "report-interrupted", requestId: id });
  });

  it("reports a taken request with no outcome as interrupted", () => {
    expect(
      watcherAction(
        {
          current: { REQUEST_ID: id },
          status: { STATE: "updated", REQUEST_ID: other },
        },
        base
      )
    ).toEqual({ kind: "report-interrupted", requestId: id });
  });

  it("leaves a run alone while installing it", () => {
    expect(
      watcherAction(
        { status: { STATE: "running", REQUEST_ID: id } },
        { ...base, installing: true }
      )
    ).toEqual({ kind: "stamp" });
  });

  it("still starts a request already copied to current.env", () => {
    expect(
      watcherAction(
        {
          request: { REQUEST_ID: id },
          current: { REQUEST_ID: id },
          status: { STATE: "updated", REQUEST_ID: other },
        },
        base
      )
    ).toEqual({ kind: "start", requestId: id, toVersion: "1.5.0" });
  });
});

describe("bindHost", () => {
  it("shares only once an admin account exists", () => {
    expect(bindHost(false, status())).toBe("127.0.0.1");
    expect(bindHost(true, null)).toBe("127.0.0.1");
    expect(bindHost(true, status({ setup_required: true }))).toBe("127.0.0.1");
    expect(bindHost(true, status({ setup_required: false }))).toBe("0.0.0.0");
  });
});

describe("file formats", () => {
  it("writes times without milliseconds", () => {
    expect(isoSeconds(NOW + 123)).toBe("2026-11-24T10:00:00Z");
  });

  it("quotes paths with spaces and odd characters in Exec=", () => {
    expect(
      desktopExec("/home/José Núñez/Horde $1.AppImage", ["--hidden"])
    ).toBe('"/home/José Núñez/Horde \\\\$1.AppImage" "--hidden"');
  });
});
