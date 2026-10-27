import { describe, expect, it } from "vitest";
import {
  actionForKey,
  assignHotkey,
  keyLabel,
  normalizeHotkeyOverrides,
  resetHotkey,
  resolveHotkeys,
} from "./hotkeys";

describe("hotkeys", () => {
  it("uses the defaults until an action is rebound", () => {
    const map = resolveHotkeys({});
    expect(actionForKey(map, " ")).toBe("playPause");
    expect(actionForKey(map, "K")).toBe("playPause");
    expect(actionForKey(map, "/")).toBe("focusSearch");
    expect(actionForKey(map, "q")).toBeNull();
  });

  it("rebinding replaces the action's keys and frees the key elsewhere", () => {
    const overrides = assignHotkey({}, "theater", "k");
    const map = resolveHotkeys(overrides);
    expect(map.theater).toEqual(["k"]);
    expect(map.playPause).toEqual([" "]);
    expect(actionForKey(map, "t")).toBeNull();
    expect(actionForKey(map, "k")).toBe("theater");
  });

  it("stores letters lower case and resets one action", () => {
    const overrides = assignHotkey({}, "captions", "S");
    expect(overrides.captions).toEqual(["s"]);
    expect(resolveHotkeys(resetHotkey(overrides, "captions")).captions).toEqual(
      ["c"]
    );
  });

  it("reset takes the default keys back from other actions", () => {
    const stolen = assignHotkey({}, "seekBack", "k");
    const map = resolveHotkeys(resetHotkey(stolen, "playPause"));
    expect(map.playPause).toEqual([" ", "k"]);
    expect(map.seekBack).toEqual([]);
    expect(actionForKey(map, "k")).toBe("playPause");
  });

  it("drops unknown actions and reserved keys from saved overrides", () => {
    expect(
      normalizeHotkeyOverrides({
        theater: ["Escape", "Y"],
        bogus: ["x"],
        captions: "c",
      })
    ).toEqual({ theater: ["y"] });
    expect(normalizeHotkeyOverrides(null)).toEqual({});
  });

  it("labels keys for display", () => {
    expect(keyLabel(" ")).toBe("Space");
    expect(keyLabel("ArrowLeft")).toBe("←");
    expect(keyLabel("k")).toBe("K");
  });
});
