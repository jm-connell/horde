import { describe, expect, it } from "vitest";
import type { UpdateControl } from "../types";
import { isUpdateActive, updatePollInterval } from "./update";

const base: UpdateControl = {
  watcher_connected: true,
  state: "idle",
  log_tail: [],
};

describe("updatePollInterval", () => {
  it("polls fast while an update is requested or running", () => {
    expect(updatePollInterval({ ...base, state: "requested" })).toBe(3000);
    expect(updatePollInterval({ ...base, state: "running" })).toBe(3000);
  });
  it("polls moderately until the watcher is connected", () => {
    expect(updatePollInterval(undefined)).toBe(15000);
    expect(updatePollInterval({ ...base, watcher_connected: false })).toBe(
      15000
    );
  });
  it("polls slowly otherwise", () => {
    expect(updatePollInterval(base)).toBe(60000);
    expect(updatePollInterval({ ...base, state: "updated" })).toBe(60000);
  });
  it("keeps polling fast when not connected but running", () => {
    expect(
      updatePollInterval({
        ...base,
        watcher_connected: false,
        state: "running",
      })
    ).toBe(3000);
  });
});

describe("isUpdateActive", () => {
  it("is false for finished states and missing data", () => {
    expect(isUpdateActive(null)).toBe(false);
    expect(isUpdateActive({ ...base, state: "failed" })).toBe(false);
    expect(isUpdateActive({ ...base, state: "running" })).toBe(true);
  });
});
