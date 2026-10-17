import { describe, expect, it } from "vitest";
import type { UpdateControl } from "../../../types";
import { describeUpdate } from "./updateView";

const c = (over: Partial<UpdateControl>): UpdateControl => ({
  watcher_connected: true,
  state: "idle",
  log_tail: [],
  ...over,
});

describe("describeUpdate", () => {
  it("shows nothing without data or when idle", () => {
    expect(describeUpdate(null, false).message).toBeNull();
    expect(describeUpdate(c({}), false)).toMatchObject({
      busy: false,
      message: null,
    });
  });
  it("requested is busy and cancellable", () => {
    const v = describeUpdate(c({ state: "requested" }), false);
    expect(v).toMatchObject({ busy: true, canCancel: true, tone: "progress" });
    expect(v.message).toMatch(/Waiting for the server/);
  });
  it("running is busy, not cancellable, and shows restarting when unreachable", () => {
    const run = c({ state: "running", log_tail: ["a"] });
    expect(describeUpdate(run, false)).toMatchObject({
      busy: true,
      canCancel: false,
      showLog: true,
    });
    const down = describeUpdate(run, true);
    expect(down.message).toMatch(/restarting/);
    expect(down.showLog).toBe(false);
  });
  it("maps result states to tones", () => {
    expect(describeUpdate(c({ state: "updated" }), false).tone).toBe("success");
    expect(describeUpdate(c({ state: "up_to_date" }), false).tone).toBe(
      "muted"
    );
    expect(describeUpdate(c({ state: "rolled_back" }), false).tone).toBe(
      "warning"
    );
    expect(describeUpdate(c({ state: "failed" }), false).tone).toBe("error");
    expect(describeUpdate(c({ state: "interrupted" }), false).tone).toBe(
      "warning"
    );
  });
  it("offers details for failures only when there is a log", () => {
    expect(describeUpdate(c({ state: "failed" }), false).showLog).toBe(false);
    expect(
      describeUpdate(c({ state: "failed", log_tail: ["x"] }), false).showLog
    ).toBe(true);
  });
});
