import { describe, expect, it } from "vitest";
import {
  firstMatchingAiPane,
  firstMatchingTab,
  matchesQuery,
  resolveAiPaneParam,
} from "./search";

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
    expect(firstMatchingTab("ollama")).toBe("ai");
    expect(firstMatchingAiPane("ollama")).toBe("providers");
    expect(firstMatchingAiPane("summary")).toBe("features");
  });
  it("resolves AI pane params", () => {
    expect(resolveAiPaneParam("jobs")).toBe("jobs");
    expect(resolveAiPaneParam("nope")).toBeNull();
  });
});
