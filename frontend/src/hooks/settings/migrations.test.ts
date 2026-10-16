import { describe, expect, it } from "vitest";
import { DEFAULTS } from "./defaults";
import { migratePanelTranslucency, normalizeSettings } from "./migrations";
import { serverUiToSettingsPatch, settingsToServerUi } from "./serverUi";

describe("normalizeSettings", () => {
  it("fills every missing field from the defaults", () => {
    expect(normalizeSettings({})).toEqual(DEFAULTS);
  });

  it("maps a retired theme name onto its replacement", () => {
    const next = normalizeSettings({ theme: "macos" as never });
    expect(next.theme).toBe("slate");
  });

  it("falls back to the default theme for an unknown one", () => {
    expect(normalizeSettings({ theme: "nope" as never }).theme).toBe("default");
  });

  it("turns an old UI scale percentage into a font size", () => {
    expect(normalizeSettings({ uiScale: 85 }).fontSize).toBe("small");
    expect(normalizeSettings({ uiScale: 100 }).fontSize).toBe("medium");
    expect(normalizeSettings({ uiScale: 130 }).fontSize).toBe("large");
    // A saved font size wins over the legacy scale.
    expect(normalizeSettings({ fontSize: "xl", uiScale: 85 }).fontSize).toBe(
      "xl"
    );
  });

  it("drops the legacy keys it migrates from", () => {
    const next = normalizeSettings({
      liquidNav: true,
      translucentPanels: true,
      uiScale: 100,
      aiTab: "x",
    });
    for (const key of ["liquidNav", "translucentPanels", "uiScale", "aiTab"]) {
      expect(next).not.toHaveProperty(key);
    }
  });

  it("clamps the panel sliders into 0..1", () => {
    const next = normalizeSettings({
      translucentPanelStrength: 4,
      translucentPanelBlur: -2,
    });
    expect(next.translucentPanelStrength).toBe(1);
    expect(next.translucentPanelBlur).toBe(0);
  });
});

describe("migratePanelTranslucency", () => {
  it("keeps independent sliders when a blur value is saved", () => {
    expect(
      migratePanelTranslucency({
        translucentPanelStrength: 0.4,
        translucentPanelBlur: 0.25,
      })
    ).toEqual({ translucentPanelStrength: 0.4, translucentPanelBlur: 0.25 });
  });

  it("treats the old off toggle as fully opaque", () => {
    expect(migratePanelTranslucency({ translucentPanels: false })).toEqual({
      translucentPanelStrength: 0,
      translucentPanelBlur: 0,
    });
  });

  it("un-couples the old blur from the strength when the toggle was on", () => {
    const out = migratePanelTranslucency({
      translucentPanels: true,
      translucentPanelStrength: 0.65,
    });
    expect(out.translucentPanelStrength).toBe(0.65);
    // (1 - 0.65) * 14px of blur, as a share of the 24px maximum.
    expect(out.translucentPanelBlur).toBeCloseTo((0.35 * 14) / 24);
  });

  it("uses the defaults when nothing was saved", () => {
    expect(migratePanelTranslucency({})).toEqual({
      translucentPanelStrength: DEFAULTS.translucentPanelStrength,
      translucentPanelBlur: DEFAULTS.translucentPanelBlur,
    });
  });
});

describe("server ui mapping", () => {
  it("sends snake_case keys and leaves out session-only fields", () => {
    const ui = settingsToServerUi({ ...DEFAULTS, theme: "nord" });
    expect(ui.theme).toBe("nord");
    expect(ui).toHaveProperty("default_library_sort");
    expect(ui).not.toHaveProperty("progress_expiry_days");
    expect(Object.keys(ui).every((k) => k === k.toLowerCase())).toBe(true);
  });

  it("reads snake_case back into the same settings", () => {
    const original = {
      ...DEFAULTS,
      theme: "nord" as const,
      fontSize: "xl" as const,
    };
    const patch = serverUiToSettingsPatch(settingsToServerUi(original));
    expect(normalizeSettings({ ...DEFAULTS, ...patch })).toEqual(original);
  });

  it("ignores keys the app does not know", () => {
    expect(serverUiToSettingsPatch({ not_a_setting: 1 })).toEqual({});
  });

  it("migrates an old blob that stored a toggle instead of a blur slider", () => {
    const patch = serverUiToSettingsPatch({
      translucent_panels: false,
    });
    expect(patch.translucentPanelStrength).toBe(0);
    expect(patch.translucentPanelBlur).toBe(0);
  });
});
