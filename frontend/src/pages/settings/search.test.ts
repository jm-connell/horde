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
    expect(firstMatchingTab("self promo")).toBe("playback");
    expect(firstMatchingTab("filler")).toBe("playback");
    expect(firstMatchingTab("ask to skip")).toBe("playback");
    expect(firstMatchingTab("custom css")).toBe("appearance");
    expect(firstMatchingTab("enable custom css")).toBe("appearance");
    expect(firstMatchingTab("jellyfin")).toBe("appearance");
    expect(firstMatchingTab("ollama")).toBe("ai");
    expect(firstMatchingTab("po token")).toBe("system");
    expect(firstMatchingAiPane("ollama")).toBe("providers");
    expect(firstMatchingAiPane("summary")).toBe("features");
    expect(firstMatchingAiPane("chapters")).toBe("features");
    expect(firstMatchingAiPane("on download")).toBe("features");
    expect(firstMatchingAiPane("index missing")).toBe("jobs");
    expect(firstMatchingTab("index missing")).toBe("ai");
    expect(firstMatchingTab("direct youtube search")).toBe("library");
    expect(firstMatchingTab("youtube video search")).toBe("library");
    expect(firstMatchingTab("av1")).toBe("library");
    expect(firstMatchingTab("h265")).toBe("library");
    expect(firstMatchingTab("beta")).toBe("library");
    expect(firstMatchingTab("hover preview")).toBe("playback");
    expect(firstMatchingTab("thumbnail preview")).toBe("playback");
    expect(firstMatchingTab("preview when centered")).toBe("playback");
    expect(firstMatchingTab("none detected")).toBe("system");
  });
  it("resolves AI pane params", () => {
    expect(resolveAiPaneParam("jobs")).toBe("jobs");
    expect(resolveAiPaneParam("nope")).toBeNull();
  });
});
