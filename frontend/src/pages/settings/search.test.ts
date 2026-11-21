import { describe, expect, it } from "vitest";
import {
  firstMatchingAiPane,
  firstMatchingTab,
  matchesQuery,
  resolveAiPaneParam,
  tabMatchesQuery,
} from "./search";
import { ADMIN_ONLY_TABS, TABS } from "./constants";

describe("matchesQuery", () => {
  it("matches substring and token AND", () => {
    expect(matchesQuery("theme", "color theme palette")).toBe(true);
    expect(matchesQuery("theme color", "color theme palette")).toBe(true);
    expect(matchesQuery("missing", "color theme")).toBe(false);
    expect(matchesQuery("", "anything")).toBe(true);
  });
});

describe("settings search routing", () => {
  it("finds tabs and AI panes", () => {
    expect(firstMatchingTab("sponsorblock")).toBe("playback");
    expect(firstMatchingTab("self promo")).toBe("playback");
    expect(firstMatchingTab("filler")).toBe("playback");
    expect(firstMatchingTab("ask to skip")).toBe("playback");
    expect(firstMatchingTab("helix")).toBe("appearance");
    expect(firstMatchingTab("leapfrog")).toBe("appearance");
    expect(firstMatchingTab("equalizer")).toBe("appearance");
    expect(firstMatchingTab("custom css")).toBe("appearance");
    expect(firstMatchingTab("enable custom css")).toBe("appearance");
    expect(firstMatchingTab("jellyfin")).toBe("appearance");
    expect(firstMatchingTab("ollama")).toBe("ai");
    expect(firstMatchingTab("po token")).toBe("system");
    expect(firstMatchingAiPane("ollama")).toBe("providers");
    expect(firstMatchingAiPane("summary")).toBe("features");
    expect(firstMatchingAiPane("chapters")).toBe("features");
    expect(firstMatchingAiPane("on download")).toBe("features");
    expect(firstMatchingTab("ai video chat")).toBe("ai");
    expect(firstMatchingAiPane("ai video chat")).toBe("features");
    expect(firstMatchingAiPane("video chat")).toBe("features");
    expect(firstMatchingAiPane("index missing")).toBe("jobs");
    expect(firstMatchingTab("index missing")).toBe("ai");
    expect(firstMatchingTab("direct youtube search")).toBe("library");
    expect(firstMatchingTab("youtube video search")).toBe("library");
    expect(firstMatchingTab("av1")).toBe("library");
    expect(firstMatchingTab("h265")).toBe("library");
    expect(firstMatchingTab("sidecar")).toBe("library");
    expect(firstMatchingTab("hover preview")).toBe("playback");
    expect(firstMatchingTab("thumbnail preview")).toBe("playback");
    expect(firstMatchingTab("preview when centered")).toBe("playback");
    expect(firstMatchingTab("none detected")).toBe("system");
    expect(firstMatchingTab("factory reset")).toBe("system");
    expect(firstMatchingTab("erase")).toBe("system");
  });
  it("finds a background by name, without taking other tabs' words", () => {
    expect(firstMatchingTab("northern lights")).toBe("appearance");
    expect(firstMatchingTab("spiral galaxy")).toBe("appearance");
    expect(firstMatchingTab("contours")).toBe("appearance");
    // A background's own slider.
    expect(firstMatchingTab("streak length")).toBe("appearance");
    // Words in the options' descriptions that belong elsewhere.
    expect(firstMatchingTab("system")).toBe("system");
    expect(firstMatchingTab("play")).not.toBe("appearance");
    expect(firstMatchingTab("sync")).not.toBe("appearance");
    expect(firstMatchingTab("core")).toBe("ai");
    expect(firstMatchingTab("button")).toBe("ai");
  });
  it("skips settings the user does not see", () => {
    const member = (access: string) => access !== "admin";
    const memberTabs = TABS.filter((t) => !ADMIN_ONLY_TABS.has(t.id));
    expect(firstMatchingTab("av1", member, memberTabs)).toBeNull();
    expect(firstMatchingTab("ollama", member, memberTabs)).toBeNull();
    expect(firstMatchingTab("normalize volume", member, memberTabs)).toBe(
      "library"
    );
    expect(tabMatchesQuery("library", "sidecar", member)).toBe(false);
    expect(tabMatchesQuery("library", "sidecar")).toBe(true);
  });
  it("resolves AI pane params", () => {
    expect(resolveAiPaneParam("jobs")).toBe("jobs");
    expect(resolveAiPaneParam("nope")).toBeNull();
  });
});
