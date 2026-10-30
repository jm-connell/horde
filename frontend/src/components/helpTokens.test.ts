import { describe, expect, it } from "vitest";
// The catalog the server ships (and serves at /api/ai/help/catalog).
import shipped from "../../../backend/app/services/ai/help_catalog.json";
import { DEFAULTS } from "../hooks/settings/defaults";
import { normalizeSettings } from "../hooks/settings/migrations";
import type { HelpCatalog, HelpCatalogSetting } from "../types";
import {
  cssBlocks,
  parseToken,
  personalPatch,
  readKey,
  resolveValue,
  settingHref,
  splitActions,
} from "./helpTokens";

const catalog = shipped as unknown as HelpCatalog;
const byId = (id: string): HelpCatalogSetting => {
  const found = catalog.settings.find((s) => s.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("parseToken", () => {
  it("reads every kind", () => {
    expect(parseToken("[[setting:background-effect]]")).toEqual({
      kind: "setting",
      id: "background-effect",
    });
    expect(parseToken("[[set:theme=oled]]")).toEqual({
      kind: "set",
      id: "theme",
      value: "oled",
    });
    expect(parseToken("[[video:12|Soup [HD] | part 2]]")).toEqual({
      kind: "video",
      id: 12,
      title: "Soup [HD] | part 2",
    });
    expect(parseToken("[[playlist-new:Cooking, soups|3, 4,#5,4]]")).toEqual({
      kind: "playlist-new",
      name: "Cooking, soups",
      videoIds: [3, 4, 5],
    });
    expect(parseToken("[[playlist-add:#7|1]]")).toEqual({
      kind: "playlist-add",
      playlistId: 7,
      videoIds: [1],
    });
    expect(parseToken("[[download:https://youtu.be/abc]]")).toEqual({
      kind: "download",
      url: "https://youtu.be/abc",
    });
  });

  it.each([
    "[[download:javascript:alert(1)]]",
    "[[download:ftp://x.example/a]]",
    "[[setting:Not An Id]]",
    "[[set:theme]]",
    "[[video:abc|x]]",
    "[[playlist-new:|1,2]]",
    "[[playlist-new:Mix|1,x]]",
    "[[playlist-add:mine|1]]",
    "[[unknown:x]]",
  ])("refuses %s", (raw) => {
    expect(parseToken(raw)).toBeNull();
  });
});

describe("splitActions", () => {
  it("takes actions out of the text, once each, and keeps links", () => {
    const { text, actions } = splitActions(
      "Done: [[set:theme=oled]]\nSee [[setting:theme]].\n[[set:theme=oled]] [[download:https://x.example/v]]"
    );
    expect(text).toBe("Done:\nSee [[setting:theme]].\n");
    expect(actions.map((a) => a.kind)).toEqual(["set", "download"]);
  });

  it("drops malformed actions without a card", () => {
    expect(splitActions("x [[download:nope]] y")).toEqual({
      text: "x  y",
      actions: [],
    });
  });
});

describe("cssBlocks", () => {
  it("finds css fences only", () => {
    const reply =
      "Try:\n```css\n.ui-card { border-radius: 2rem; }\n```\n```js\nx()\n```";
    expect(cssBlocks(reply)).toEqual([".ui-card { border-radius: 2rem; }"]);
  });
});

describe("resolveValue", () => {
  it("understands switches, choices, numbers and colors", () => {
    expect(resolveValue(byId("sponsorblock"), "on")).toMatchObject({
      ok: true,
      value: true,
    });
    expect(resolveValue(byId("theme"), "OLED (true black)")).toMatchObject({
      ok: true,
      value: "oled",
    });
    expect(resolveValue(byId("playback-speed"), "1.5x")).toMatchObject({
      ok: true,
      value: 1.5,
      label: "1.5×",
    });
    expect(resolveValue(byId("panel-transparency"), "30%")).toMatchObject({
      ok: true,
      value: 0.3,
      label: "30%",
    });
    expect(resolveValue(byId("panel-transparency"), "0.3")).toMatchObject({
      value: 0.3,
    });
    expect(resolveValue(byId("accent-color"), "#F80")).toMatchObject({
      ok: true,
      value: "#ff8800",
    });
  });

  it("refuses what the setting does not take, and link-only settings", () => {
    expect(resolveValue(byId("theme"), "purple").ok).toBe(false);
    expect(resolveValue(byId("hold-speed"), "40").ok).toBe(false);
    expect(resolveValue(byId("accent-color"), "red").ok).toBe(false);
    expect(resolveValue(byId("reset"), "true").ok).toBe(false);
  });
});

describe("settingHref", () => {
  it("opens the tab and pane and finds the anchor", () => {
    expect(settingHref(byId("ai-summaries"))).toBe(
      "/settings?tab=ai&pane=features&find=ai-features"
    );
    expect(settingHref(byId("account-password"))).toBe(
      "/account?find=password"
    );
  });
});

describe("personalPatch", () => {
  it("sets nested keys and what they imply, and undoes both", () => {
    const settings = normalizeSettings({});
    const { apply, undo } = personalPatch(
      byId("accent-color"),
      "#ff8800",
      settings
    );
    expect(apply).toEqual({
      customColors: { ...settings.customColors, accent: "#ff8800" },
      theme: "custom",
    });
    expect(undo).toEqual({
      customColors: settings.customColors,
      theme: settings.theme,
    });
  });
});

describe("the shipped catalog", () => {
  it("only proposes values the settings keep", () => {
    for (const s of catalog.settings) {
      if (s.chat !== "change" || s.scope !== "personal") continue;
      const samples: (string | number | boolean)[] =
        s.type === "bool"
          ? [true, false]
          : s.type === "enum"
            ? (s.options ?? []).map((o) => o.value)
            : s.type === "number"
              ? [s.min ?? 0, s.max ?? 1]
              : ["#123456"];
      for (const value of samples) {
        const { apply } = personalPatch(s, value, DEFAULTS);
        const kept = normalizeSettings({ ...DEFAULTS, ...apply });
        expect(readKey(kept, s.key ?? s.id), `${s.id}=${value}`).toEqual(value);
      }
    }
  });
});
